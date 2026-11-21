package io.github.mattcrum.hermesdisplay

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.media.audiofx.Visualizer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Calendar
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Hermes Display for the Meta Portal.
 *
 * Native side: offline wake word (Vosk), capture + VAD, bridge calls, audio playback, timers/alarms.
 * UI side: a bundled web page (assets/ui) driven through window.HV.* and calling back via window.Native.*.
 *
 *  WAKE      Vosk listens for the wake phrases (also while SPEAKING, for barge-in; "stop" while ringing)
 *  LISTENING AudioRecord + energy VAD captures the question
 *  THINKING  POST /voice/turn (or /voice/text for a tapped suggestion)
 *  SPEAKING  MediaPlayer + Visualizer (drives the orb); follow-up listening if Hermes asked a question
 */
class MainActivity : Activity() {

    private enum class State(val js: String) {
        LOADING("loading"), WAKE("wake"), LISTENING("listening"), THINKING("thinking"), SPEAKING("speaking"), ERROR("error")
    }

    private companion object {
        const val TAG = "PortalVoice"
        const val RATE = 16000
        const val FRAME = 320                  // 20 ms
        const val MIN_RMS = 350.0
        const val SILENCE_MS = 1200
        const val MAX_MS = 30000
        const val IGNORE_START_MS = 250
        const val SESSION_IDLE_MS = 10 * 60 * 1000L
        const val AMBIENT_EVERY_MS = 5 * 60 * 1000L
        const val RING_MAX_MS = 2 * 60 * 1000L
        const val DEFAULT_BASE = ""            // set in Settings or by intent: see README "Install"
        const val DEFAULT_WAKE = "hey hermes"
        const val OLD_DEFAULT_WAKE = "hey hermes,okay hermes"

        /**
         * Decoy words in the grammar. With only "hey hermes" + [unk] to choose from, the decoder turned a bare
         * "hey"/"hi" plus room noise into "hey hermes". Giving it plausible alternatives (and "hermes" alone)
         * removed every false trigger in testing while keeping all true ones (see docs/wake-word.md).
         */
        val DECOYS = listOf("hey", "hi", "hello", "okay", "ok", "hermes", "her", "hers", "mess", "homes",
            "herman", "hermit", "hey there")
        const val WAKE_STREAK = 2   // consecutive partial results containing the phrase
    }

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()   // capture + turns (serial)
    private val net = Executors.newSingleThreadExecutor()      // ambient refresh
    private lateinit var prefs: SharedPreferences
    private lateinit var web: WebView
    private lateinit var health: Health
    private var ambientFails = 0                                // main thread only
    private val ambientRetry = Runnable { refreshAmbient() }
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private var pageReady = false
    private var convGen = 0  // bumped by "New conversation"; main thread only
    private val jsQueue = ArrayList<String>()

    private var model: Model? = null
    private var recognizer: Recognizer? = null
    private var verifier: Recognizer? = null
    private var speech: WakeListener? = null
    private var wakeTest: String? = null   // debug: next wake listener replays this file
    private var replaying = false
    private var verifying = false   // stage-2 check in flight; main thread only
    private var player: MediaPlayer? = null
    private var visualizer: Visualizer? = null
    private var state = State.LOADING
    @Volatile private var stopNow = false
    private var lastHeard = ""
    private var followUps = 0   // follow-up captures since the user last started a turn (wake, tap or chip); main thread only

    // timers: id -> (label, endsAt, total, kind)
    private data class Timer(val id: String, val label: String, val endsAt: Long, val total: Long, val kind: String)
    private val timers = ArrayList<Timer>()
    private var ringing: Timer? = null
    private var ringtone: Ringtone? = null
    private var ringStarted = 0L

    // ---------------------------------------------------------------- lifecycle

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("pv", MODE_PRIVATE)
        health = Health(this) { state.js }.also { it.start() }
        if (prefs.getString("wake", null) == OLD_DEFAULT_WAKE) prefs.edit().remove("wake").apply()  // drop "okay hermes"
        applyIntent(intent)
        loadTimers()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this).apply {
            setBackgroundColor(0xFF07071A.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.mediaPlaybackRequiresUserGesture = false
            overScrollMode = View.OVER_SCROLL_NEVER
            isVerticalScrollBarEnabled = false
            webViewClient = object : WebViewClient() {
                // The renderer died (crash or OOM-kill). Without this the whole app is torn down; rebuild instead.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    health.event("RENDERER GONE crashed=${detail.didCrash()} priority=${detail.rendererPriorityAtExit()}")
                    (view.parent as? ViewGroup)?.removeView(view)
                    main.post { recreate() }
                    return true
                }
            }
            webChromeClient = WebChromeClient()
            addJavascriptInterface(Bridge(), "Native")
            loadUrl("file:///android_asset/ui/index.html")
        }
        setContentView(web)

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) loadModel()
        else requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)

        main.post(object : Runnable {
            override fun run() { timerTick(); main.postDelayed(this, 1000) }
        })
        main.postDelayed(object : Runnable {
            override fun run() { refreshAmbient(); main.postDelayed(this, AMBIENT_EVERY_MS) }
        }, AMBIENT_EVERY_MS)

        // Boot race: the app starts before Wi-Fi, so the first calendar/weather fetch fails. Refresh as soon as
        // a network is up (and on every reconnect) instead of waiting for the 5-minute timer.
        netCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { main.postDelayed({ refreshAmbient() }, 1500) }
        }.also { getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val wakeBefore = wakePhrases
        applyIntent(intent)
        pushSettings()
        if (model != null && (state == State.WAKE || state == State.ERROR)) {
            if (wakePhrases != wakeBefore) { stopWake(); buildRecognizer() }
            goWake()
        }
        refreshAmbient()
        // Debug builds: `--es wake_test pod.wav` replays files/wake-test/pod.wav through the wake pipeline once.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) intent.getStringExtra("wake_test")?.let { name ->
            main.postDelayed({ wakeTest = File(name).name; if (state == State.WAKE) goWake() }, 1000)  // after onResume
        }
        // `--es ask "..."`: run a typed turn (testing, or automation from the Mac / a Hermes cron).
        intent.getStringExtra("ask")?.takeIf { it.isNotBlank() }?.let { q -> main.postDelayed({ askText(q) }, 300) }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        if (results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED) loadModel()
        else setState(State.ERROR, "Microphone permission is required")
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        if (model != null && (state == State.WAKE || state == State.ERROR)) goWake()
    }

    override fun onPause() {
        super.onPause()
        if (state == State.WAKE) stopWake()
    }

    override fun onDestroy() {
        netCallback?.let { try { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) } catch (e: Exception) {} }
        main.removeCallbacksAndMessages(null)
        health.stop()
        stopWake(); stopPlayer(); stopRinging()
        recognizer?.close(); verifier?.close(); model?.close()
        worker.shutdownNow(); net.shutdownNow()
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Home-screen app: Back does nothing.")
    override fun onBackPressed() { js("HV.state && document.getElementById('settings').classList.add('hidden')") }

    /** `adb shell am start -n io.github.mattcrum.hermesdisplay/.MainActivity --es key ... [--es base_url ...] [--es wake ...]` */
    private fun applyIntent(i: Intent?) {
        val e = prefs.edit()
        val newKey = i?.getStringExtra("key")?.takeIf { it.isNotBlank() }?.trim()
        val newUrl = i?.getStringExtra("base_url")?.takeIf { it.isNotBlank() }?.let { normalizeBase(it) }
        newKey?.let { e.putString("key", it) }
        newUrl?.let { e.putString("base_url", it) }
        // The activity is exported (it's HOME), so any app can send these extras. Never let one point the
        // stored key at a new server: a base_url change by intent must carry its own key, or the key is dropped.
        if (newUrl != null && newUrl != baseUrl && newKey == null) e.remove("key")
        i?.getStringExtra("wake")?.takeIf { it.isNotBlank() }?.let { e.putString("wake", it.trim().lowercase()) }
        e.apply()
    }

    /** "192.168.1.50:8650" or "http://host:8650/" becomes "http://host:8650/voice". A URL with a path is kept as typed. */
    private fun normalizeBase(raw: String): String {
        var u = raw.trim().trimEnd('/')
        if (u.isEmpty()) return u
        if (!u.contains("://")) u = "http://$u"
        val path = runCatching { java.net.URI(u).path }.getOrNull().orEmpty()
        return if (path.isEmpty()) "$u/voice" else u
    }

    private val key get() = prefs.getString("key", "") ?: ""
    private val configured get() = key.isNotEmpty() && baseUrl.isNotEmpty()
    private val baseUrl get() = prefs.getString("base_url", DEFAULT_BASE) ?: DEFAULT_BASE
    private val wakePhrases get() = (prefs.getString("wake", DEFAULT_WAKE) ?: DEFAULT_WAKE)
        .split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }

    // ---------------------------------------------------------------- JS plumbing

    private fun js(code: String) {
        main.post {
            if (!pageReady) { jsQueue.add(code); return@post }
            web.evaluateJavascript(code, null)
        }
    }

    private fun q(s: String) = JSONObject.quote(s)

    private fun setState(s: State, info: String = "") {
        if (s != state) Log.i(TAG, "state $state -> $s ${if (info.isNotEmpty()) "($info)" else ""}")
        state = s
        js("HV.state(${q(s.js)}, ${q(info)})")
    }

    private fun pushSettings() {
        val o = JSONObject()
            .put("url", baseUrl).put("wake", wakePhrases.joinToString(","))
            .put("theme", prefs.getString("theme", "auto")).put("clock", prefs.getString("clock", "12"))
            .put("cal", prefs.getString("cal", "on")).put("hasKey", key.isNotEmpty())
            .put("version", runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrDefault(""))
        js("HV.settings($o)")
    }

    private inner class Bridge {
        @JavascriptInterface fun ready() = main.post {
            pageReady = true
            jsQueue.forEach { web.evaluateJavascript(it, null) }
            jsQueue.clear()
            pushSettings(); pushTimers()
            js("HV.state(${q(state.js)}, '')")
            refreshAmbient()
        }
        @JavascriptInterface fun tap() = main.post { onTap() }
        @JavascriptInterface fun ask(text: String) = main.post { askText(text) }
        @JavascriptInterface fun stopAll() = main.post {
            if (ringing != null) stopRinging()
            if (state == State.SPEAKING) goWake()
        }
        @JavascriptInterface fun newConversation() = main.post { convGen++; prefs.edit().remove("session_id").apply() }
        @JavascriptInterface fun cancelTimer(id: String) = main.post {
            timers.removeAll { it.id == id }; saveTimers(); pushTimers()
        }
        @JavascriptInterface fun portalSettings() = main.post {
            runCatching { startActivity(Intent(android.provider.Settings.ACTION_SETTINGS)) }
        }
        @JavascriptInterface fun saveSettings(json: String) = main.post {
            val o = runCatching { JSONObject(json) }.getOrNull() ?: return@post
            val wakeBefore = wakePhrases
            val e = prefs.edit()
            o.optString("key").takeIf { it.isNotBlank() }?.let { e.putString("key", it.trim()) }
            o.optString("url").takeIf { it.isNotBlank() }?.let { e.putString("base_url", normalizeBase(it)) }
            o.optString("wake").takeIf { it.isNotBlank() }?.let { e.putString("wake", it.trim().lowercase()) }
            for (k in listOf("theme", "clock", "cal")) o.optString(k).takeIf { it.isNotBlank() }?.let { e.putString(k, it) }
            e.apply()
            pushSettings()
            if (model != null && wakePhrases != wakeBefore) { stopWake(); buildRecognizer() }
            if (model != null && (state == State.WAKE || state == State.ERROR)) goWake()
            refreshAmbient()
        }
    }

    // ---------------------------------------------------------------- wake word

    private fun loadModel() {
        setState(State.LOADING, "Loading wake word")
        StorageService.unpack(this, "model-en-us", "model",
            { m: Model -> model = m; buildRecognizer(); goWake() },
            { e: IOException -> setState(State.ERROR, "Wake model failed: ${e.message}") })
    }

    // Two-word stop phrases: a bare "stop" was falsely decoded from the alarm tone itself.
    private val stopPhrases = listOf("stop timer", "stop the timer", "stop alarm", "stop the alarm", "hermes stop")
    private fun grammarPhrases(): List<String> {
        val wake = wakePhrases
        val decoys = (DECOYS + wake.flatMap { it.split(' ') }).distinct().filter { it !in wake }
        return (wake + decoys + (if (ringing != null) stopPhrases else emptyList()) + "[unk]").distinct()
    }

    /** Whole-word phrase match ("hey hermes" must not match inside "they hermes…"). */
    private fun hasPhrase(text: String, phrases: List<String>) =
        phrases.any { p -> Regex("(^| )" + Regex.escape(p) + "( |$)").containsMatchIn(text) }

    private var wakeStreak = 0

    private fun buildRecognizer() {
        recognizer?.close()
        recognizer = Recognizer(model, RATE.toFloat(), JSONArray(grammarPhrases()).toString())
        if (verifier == null) verifier = Recognizer(model, RATE.toFloat()).apply {
            setMaxAlternatives(5)
            acceptWaveForm(ShortArray(RATE / 2), RATE / 2); finalResult   // warm up: the first decode took 1.5 s
        }
    }

    /** Stage-1 results from the grammar spotter (main thread). See [WakeListener] for the two stages. */
    private fun onWakeText(text: String, field: String) {
        if (verifying) return
        if (text.isNotEmpty() && text != lastHeard) { lastHeard = text; Log.d(TAG, "heard($field): '$text'") }
        if (text.isEmpty()) { if (field == "partial") wakeStreak = 0; return }
        if (ringing != null) {
            val said = hasPhrase(text, stopPhrases) || hasPhrase(text, wakePhrases)
            if (said && System.currentTimeMillis() - ringStarted > 2000) { Log.i(TAG, "ring stopped by voice: '$text'"); stopRinging() }
            return
        }
        val hit = hasPhrase(text, wakePhrases)
        if (field == "partial") {
            wakeStreak = if (hit) wakeStreak + 1 else 0
            if (wakeStreak < WAKE_STREAK) return
            Log.i(TAG, "wake candidate: '$text' (streak $wakeStreak)")
        } else if (hit) {
            Log.i(TAG, "wake candidate: '$text' (final)")
        } else return
        wakeStreak = 0
        // Only the default phrase has a stage-2 vocabulary; a custom phrase wakes on stage 1 alone.
        if (wakePhrases.all { it.split(' ').any { w -> w in WakeListener.ACCEPT } }) {
            verifying = true; speech?.requestVerify()
        } else onWake()
    }

    private fun onWakeVerdict(ok: Boolean, heard: String) {
        verifying = false
        lastHeard = ""
        if (ok && !replaying) onWake()   // a debug replay only logs its verdicts
    }

    /** Start (or restart) the wake listener. Keeps the current state when SPEAKING (barge-in). */
    private fun startWakeListener() {
        stopWake()
        val rec = recognizer ?: return
        val ver = verifier ?: return
        rec.setGrammar(JSONArray(grammarPhrases()).toString())
        rec.reset()
        lastHeard = ""
        wakeStreak = 0
        verifying = false
        val test = wakeTest?.let { File(getExternalFilesDir("wake-test"), it) }?.takeIf { it.isFile }
        wakeTest = null
        replaying = test != null
        speech = WakeListener(rec, ver, main, getExternalFilesDir("wake"), ::onWakeText, ::onWakeVerdict, {
            setState(State.ERROR, "Mic error")
            main.postDelayed({ if (state == State.ERROR) goWake() }, if (test != null) 300L else 3000L)
        }, test).also { it.start() }
    }

    private fun goWake() {
        stopPlayer()
        if (model == null) return
        if (!configured) {
            stopWake()
            setState(State.ERROR, if (baseUrl.isEmpty()) "Not set up — add the bridge URL in Settings" else "No voice key set — open Settings")
            return
        }
        try {
            startWakeListener()
            setState(State.WAKE)
        } catch (e: Exception) {
            Log.w(TAG, "startListening", e)
            setState(State.ERROR, "Mic busy")
            main.postDelayed({ if (state == State.ERROR) goWake() }, 3000)
        }
    }

    private fun stopWake() {
        speech?.stop()
        speech = null
        verifying = false
    }

    private fun onWake() {
        if (state != State.WAKE && state != State.SPEAKING) { speech?.resume(); return }
        followUps = 0
        val listener = speech
        stopWake()
        val pre = listener?.takePreroll()   // what was said while stage 2 was deciding (null for a stage-1-only wake)
        stopPlayer()
        startCapture(noSpeechMs = 6000, pre = pre)
    }

    /**
     * Is someone already talking in the pre-roll, beyond the tail of the wake word itself? Also returns the RMS of
     * its quietest 20 ms frame, used as the capture's noise floor.
     */
    private fun speechIn(pre: ShortArray): Pair<Boolean, Double> {
        val rms = DoubleArray(pre.size / FRAME) { f ->
            var s = 0.0
            for (i in f * FRAME until (f + 1) * FRAME) s += pre[i].toDouble() * pre[i]
            sqrt(s / FRAME)
        }
        if (rms.isEmpty()) return false to Double.MAX_VALUE
        var floor = Double.MAX_VALUE
        for (v in rms) floor = minOf(floor, v)
        val threshold = max(MIN_RMS, floor * 3)
        var loud = 0; var run = 0; var best = 0
        for (f in (WakeListener.PRE_MS + 200) / 20 until rms.size) {   // skip where "hermes" may still be ending
            if (rms[f] > threshold) { loud++; run++; best = max(best, run) } else run = 0
        }
        return (loud >= 15 && best >= 3) to floor                       // 300 ms of speech in all, 60 ms in a row
    }

    private fun onTap() {
        when (state) {
            State.WAKE, State.ERROR -> {
                if (!configured || model == null) { js("document.getElementById('gear').click()"); return }
                followUps = 0
                stopWake(); startCapture(noSpeechMs = 7000)
            }
            State.LISTENING -> stopNow = true
            State.SPEAKING -> goWake()
            else -> {}
        }
    }

    // ---------------------------------------------------------------- capture

    /**
     * [pre] is the wake listener's pre-roll. Stage 2 takes 0.7-1.6 s to confirm the wake word, so "hey hermes, what
     * time is it" said in one breath is over before the mic re-opens. If the pre-roll holds speech it is prepended to
     * the recording and counts for the end-of-speech timer, and the beep is skipped (it would land on the user's words).
     */
    private fun startCapture(noSpeechMs: Int, pre: ShortArray? = null) {
        stopNow = false
        val (talking, floor) = if (pre != null) speechIn(pre) else (false to Double.MAX_VALUE)
        if (pre != null) Log.i(TAG, "wake preroll ${pre.size * 1000 / RATE} ms, speech=$talking")
        val lead = if (talking) pre else null
        setState(State.LISTENING)
        if (lead == null) beep()
        worker.execute {
            val pcm = try { record(noSpeechMs, lead, if (lead != null) floor else Double.MAX_VALUE) } catch (e: Exception) {
                Log.w(TAG, "record", e)
                main.post { setState(State.ERROR, "Mic error"); main.postDelayed({ if (state == State.ERROR) goWake() }, 2500) }
                return@execute
            }
            main.post { if (pcm == null) goWake() else sendAudio(pcm) }
        }
    }

    /** [lead]: speech already captured by the wake listener, sent ahead of the live audio. */
    private fun record(noSpeechMs: Int, lead: ShortArray? = null, leadFloor: Double = Double.MAX_VALUE): ByteArray? {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            throw IOException("microphone permission revoked")
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBuf, RATE * 2))
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); throw IOException("microphone unavailable") }
        val out = ByteArrayOutputStream(RATE * 2 * 8)
        val frame = ShortArray(FRAME)
        val bytes = ByteBuffer.allocate(FRAME * 2).order(ByteOrder.LITTLE_ENDIAN)
        var t = 0; var heard = lead != null; var loudRun = 0; var lastLoud = 0; var noise = leadFloor
        var emptyReads = 0
        if (lead != null) {
            val bb = ByteBuffer.allocate(lead.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (s in lead) bb.putShort(s)
            out.write(bb.array())
        }
        rec.startRecording()
        try {
            while (true) {
                val n = rec.read(frame, 0, FRAME)
                if (n < 0) throw IOException("microphone read error $n")
                if (n == 0) {
                    if (stopNow) break
                    if (++emptyReads > 200) throw IOException("microphone returned no audio")
                    Thread.sleep(5)
                    continue
                }
                emptyReads = 0
                bytes.clear()
                var sum = 0.0
                for (i in 0 until n) { bytes.putShort(frame[i]); sum += frame[i].toDouble() * frame[i] }
                out.write(bytes.array(), 0, n * 2)
                val rms = sqrt(sum / n)
                t += n * 1000 / RATE
                if (t in IGNORE_START_MS..600) noise = minOf(noise, rms)
                val threshold = max(MIN_RMS, if (noise == Double.MAX_VALUE) 0.0 else noise * 3)
                if (t > IGNORE_START_MS && rms > threshold) { if (++loudRun >= 3) { heard = true; lastLoud = t } } else loudRun = 0
                if (t % 60 == 0) js("HV.level(${"%.3f".format((rms / 3500.0).coerceIn(0.0, 1.0))})")
                if (stopNow) break
                if (heard && t - lastLoud > SILENCE_MS) break
                if (!heard && t > noSpeechMs) break
                if (t > MAX_MS) break
            }
        } finally { rec.stop(); rec.release() }
        return if (heard || (stopNow && t > 600)) out.toByteArray() else null
    }

    private fun wav(pcm: ByteArray): ByteArray {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(pcm.size)
        return h.array() + pcm
    }

    // ---------------------------------------------------------------- network

    private fun currentSession(): String? {
        val sid = prefs.getString("session_id", null) ?: return null
        return if (System.currentTimeMillis() - prefs.getLong("session_ts", 0) < SESSION_IDLE_MS) sid else null
    }

    private fun sendAudio(pcm: ByteArray) {
        setState(State.THINKING)
        val session = currentSession()
        val gen = convGen
        worker.execute { runTurn(gen) { postTurn(wav(pcm), session) } }
    }

    private fun askText(text: String) {
        if (!configured) { js("document.getElementById('gear').click()"); return }
        if (state == State.LISTENING || state == State.THINKING) return
        followUps = 0
        stopWake(); stopPlayer()
        js("HV.asked(${q(text)})")
        setState(State.THINKING)
        val session = currentSession()
        val gen = convGen
        worker.execute {
            runTurn(gen) {
                val body = JSONObject().put("text", text).put("session_id", session ?: JSONObject.NULL).toString().toByteArray()
                http("POST", "$baseUrl/text", body, "application/json")
            }
        }
    }

    private fun runTurn(gen: Int, call: () -> JSONObject) {
        try {
            val json = call()
            main.post { handleReply(json, gen) }
        } catch (e: Exception) {
            Log.w(TAG, "turn failed", e)
            main.post {
                setState(State.ERROR, e.message ?: "Request failed")
                main.postDelayed({ if (state == State.ERROR) goWake() }, 4000)
            }
        }
    }

    private fun postTurn(audio: ByteArray, session: String?): JSONObject {
        val boundary = "pv" + UUID.randomUUID().toString().replace("-", "")
        val body = ByteArrayOutputStream()
        fun part(header: String) = body.write("--$boundary\r\n$header\r\n\r\n".toByteArray())
        if (session != null) {
            part("Content-Disposition: form-data; name=\"session_id\"")
            body.write(session.toByteArray()); body.write("\r\n".toByteArray())
        }
        part("Content-Disposition: form-data; name=\"audio\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav")
        body.write(audio); body.write("\r\n--$boundary--\r\n".toByteArray())
        return http("POST", "$baseUrl/turn", body.toByteArray(), "multipart/form-data; boundary=$boundary")
    }

    private fun http(method: String, url: String, body: ByteArray?, contentType: String?): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15000
            conn.readTimeout = 200000
            conn.setRequestProperty("Authorization", "Bearer $key")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", contentType)
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            if (code == 401) throw IOException("Voice key rejected — open Settings")
            if (code != 200) throw IOException("Server error $code")
            return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        } finally { conn.disconnect() }
    }

    private fun refreshAmbient() {
        if (!configured) return
        net.execute {
            try {
                val d = http("GET", "$baseUrl/ambient", null, null)
                js("HV.ambient($d)")
                main.post { ambientFails = 0; main.removeCallbacks(ambientRetry) }
            } catch (e: Exception) {
                Log.w(TAG, "ambient failed: ${e.message}")
                // Retry soon with backoff (10 s, 20 s, 40 s ... capped at the regular 5-minute refresh).
                main.post {
                    ambientFails++
                    main.removeCallbacks(ambientRetry)
                    main.postDelayed(ambientRetry, minOf(AMBIENT_EVERY_MS, 10_000L shl minOf(ambientFails - 1, 5)))
                }
            }
        }
    }

    private fun handleReply(d: JSONObject, gen: Int) {
        // Skip the session if "New conversation" was pressed while this turn was in flight.
        d.optString("session_id").takeIf { gen == convGen && it.isNotEmpty() && it != "null" }?.let {
            prefs.edit().putString("session_id", it).putLong("session_ts", System.currentTimeMillis()).apply()
        }
        val b64 = d.optString("audio_b64")
        d.remove("audio_b64")
        js("HV.turn($d)")
        d.optJSONArray("actions")?.let { runActions(it) }
        if (d.optString("transcript").isBlank()) { goWake(); return }
        // Re-open the mic once after a question. Without the limit, a false wake near a TV or podcast keeps the
        // conversation going by itself: every clarifying question captures more room speech.
        val followUp = followUps == 0 && d.optString("speech").trimEnd().endsWith("?")
        if (b64.isNotEmpty()) play(b64, followUp) else goWake()
    }

    // ---------------------------------------------------------------- device actions

    private fun runActions(arr: JSONArray) {
        for (i in 0 until arr.length()) {
            val a = arr.optJSONObject(i) ?: continue
            when (a.optString("type")) {
                "timer" -> {
                    val secs = a.optLong("seconds", 0)
                    if (secs in 1..(24 * 3600)) addTimer(a.optString("label", "Timer"), secs * 1000, "timer")
                }
                "alarm" -> {
                    val m = Regex("^(\\d{1,2}):(\\d{2})$").find(a.optString("time")) ?: continue
                    val c = Calendar.getInstance().apply {
                        set(Calendar.HOUR_OF_DAY, m.groupValues[1].toInt()); set(Calendar.MINUTE, m.groupValues[2].toInt())
                        set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
                        if (timeInMillis <= System.currentTimeMillis()) add(Calendar.DAY_OF_MONTH, 1)
                    }
                    addTimer(a.optString("label", "Alarm"), c.timeInMillis - System.currentTimeMillis(), "alarm")
                }
                "cancel_timers" -> { timers.clear(); saveTimers(); pushTimers() }
                "volume" -> {
                    val am = getSystemService(AUDIO_SERVICE) as AudioManager
                    val maxV = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                    val lvl = a.optInt("level", 5).coerceIn(0, 10)
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, (maxV * lvl + 5) / 10, 0)
                }
            }
        }
    }

    private fun addTimer(label: String, ms: Long, kind: String) {
        timers.add(Timer(UUID.randomUUID().toString().take(8), label.take(40), System.currentTimeMillis() + ms, ms, kind))
        timers.sortBy { it.endsAt }
        saveTimers(); pushTimers()
    }

    private fun pushTimers() {
        val arr = JSONArray()
        timers.forEach { arr.put(JSONObject().put("id", it.id).put("label", it.label).put("endsAt", it.endsAt).put("total", it.total).put("kind", it.kind)) }
        js("HV.timers($arr)")
    }

    private fun saveTimers() {
        val arr = JSONArray()
        timers.forEach { arr.put(JSONObject().put("id", it.id).put("label", it.label).put("endsAt", it.endsAt).put("total", it.total).put("kind", it.kind)) }
        prefs.edit().putString("timers", arr.toString()).apply()
    }

    private fun loadTimers() {
        val arr = runCatching { JSONArray(prefs.getString("timers", "[]")) }.getOrDefault(JSONArray())
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            timers.add(Timer(o.getString("id"), o.optString("label"), o.getLong("endsAt"), o.optLong("total"), o.optString("kind", "timer")))
        }
    }

    private fun timerTick() {
        val now = System.currentTimeMillis()
        val due = timers.firstOrNull { it.endsAt <= now }
        if (due != null && ringing == null) {
            timers.remove(due); saveTimers(); pushTimers()
            startRinging(due)
        }
        if (ringing != null && now - ringStarted > RING_MAX_MS) stopRinging()
    }

    private fun startRinging(t: Timer) {
        ringing = t; ringStarted = System.currentTimeMillis()
        js("HV.ringing(${JSONObject().put("label", t.label)})")
        ringtone = runCatching {
            RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))
        }.getOrNull()?.apply {
            audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
            runCatching { isLooping = true }
            play()
        }
        if (ringtone == null) beepLoop()
        if (state == State.WAKE) runCatching { startWakeListener() }   // now also listens for "stop"
    }

    private fun beepLoop() {
        if (ringing == null) return
        beep(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 600)
        main.postDelayed({ beepLoop() }, 1400)
    }

    private fun stopRinging() {
        if (ringing == null) return
        ringing = null
        ringtone?.stop(); ringtone = null
        js("HV.ringing(null)")
        if (state == State.WAKE) runCatching { startWakeListener() }
    }

    // ---------------------------------------------------------------- audio out

    private fun play(b64: String, followUp: Boolean) {
        stopPlayer()
        val f = File(cacheDir, "reply.mp3")
        f.writeBytes(Base64.decode(b64, Base64.DEFAULT))
        setState(State.SPEAKING)
        player = MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setDataSource(f.absolutePath)
            setOnCompletionListener {
                if (state != State.SPEAKING) return@setOnCompletionListener
                stopPlayer()
                if (followUp) { followUps++; stopWake(); startCapture(noSpeechMs = 6000) } else goWake()
            }
            setOnErrorListener { _, _, _ -> goWake(); true }
            prepare()
            start()
        }
        attachVisualizer(player!!.audioSessionId)
        // barge-in: keep the wake word live while Hermes talks
        runCatching { startWakeListener() }
    }

    private fun attachVisualizer(session: Int) {
        visualizer = runCatching {
            Visualizer(session).apply {
                captureSize = Visualizer.getCaptureSizeRange()[0].coerceAtLeast(256)
                setDataCaptureListener(object : Visualizer.OnDataCaptureListener {
                    override fun onWaveFormDataCapture(v: Visualizer?, wave: ByteArray?, rate: Int) {
                        if (wave == null) return
                        var sum = 0.0
                        for (b in wave) { val s = (b.toInt() and 0xff) - 128; sum += (s * s).toDouble() }
                        val rms = sqrt(sum / wave.size) / 128.0
                        js("HV.level(${"%.3f".format((rms * 6.0).coerceIn(0.0, 1.0))})")
                    }
                    override fun onFftDataCapture(v: Visualizer?, fft: ByteArray?, rate: Int) {}
                }, Visualizer.getMaxCaptureRate() / 2, true, false)
                enabled = true
            }
        }.onFailure { Log.w(TAG, "visualizer unavailable: ${it.message}") }.getOrNull()
    }

    private fun stopPlayer() {
        visualizer?.runCatching { enabled = false; release() }
        visualizer = null
        player?.runCatching { stop() }
        player?.release()
        player = null
    }

    private fun beep(tone: Int = ToneGenerator.TONE_PROP_BEEP, ms: Int = 120) {
        runCatching {
            val tg = ToneGenerator(AudioManager.STREAM_MUSIC, 70)
            tg.startTone(tone, ms)
            main.postDelayed({ tg.release() }, ms + 300L)
        }
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }
}
