package io.github.mattcrum.hermesdisplay

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.util.Log
import org.json.JSONObject
import org.vosk.Recognizer
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max

/**
 * Two-stage wake word. Replaces Vosk's SpeechService so we keep the raw audio.
 *
 *  Stage 1  the grammar-restricted [spotter] (cheap, always on). It is forced to explain *all* speech with a dozen
 *           words, so continuous talk (a podcast) keeps decoding to "hey hermes": about 4 hits a minute in testing.
 *  Stage 2  on a stage-1 hit, after [POST_MS] more audio, the last [WINDOW_MS] are re-decoded by [verifier], the same
 *           model with no grammar (full vocabulary, 5-best). Real "hey hermes" comes back containing "hermes";
 *           podcast speech comes back as what was actually said ("hey hurry up", "her mother's coming").
 *
 * The audio thread owns both recognizers while running. Partial/final results and verdicts are posted to [main].
 */
class WakeListener(
    private val spotter: Recognizer,
    private val verifier: Recognizer,
    private val main: Handler,
    private val clipDir: File?,
    private val onText: (text: String, field: String) -> Unit,
    private val onVerdict: (ok: Boolean, heard: String) -> Unit,
    private val onError: () -> Unit,
    /** Debug: feed this 16 kHz mono WAV (in real time) instead of the mic, then stop. */
    private val testWav: File? = null,
) {
    companion object {
        const val TAG = "PortalVoice"
        const val RATE = 16000
        const val CHUNK = RATE / 5            // 200 ms, same as SpeechService
        const val WINDOW_MS = 2200
        const val POST_MS = 300
        const val RING = RATE * 4             // 4 s ring buffer
        const val KEEP_CLIPS = 30
        const val PRE_MS = 150                // the pre-roll starts this long before the stage-1 hit
        const val HOLD_MS = 3000              // after a PASS, keep buffering this long for the capture to collect
        const val MIC_BUF_MS = 2000           // AudioRecord capacity: audio queues here while stage 2 decodes (up to ~1.2 s)
        /** Words the full-vocabulary decode may return for a real "hermes" (Karen's TTS voice gives "herms"). */
        val ACCEPT = setOf("hermes", "herms", "hermes's", "hermes'")
    }

    @Volatile private var running = false
    @Volatile private var verifyAt = -1L      // sample count at which to run stage 2, or -1
    private var thread: Thread? = null
    private val ring = ShortArray(RING)
    @Volatile private var seen = 0L           // samples written to the ring (audio thread writes)
    @Volatile private var hitAt = -1L         // sample count at the stage-1 hit
    @Volatile private var holding = false     // stage 2 passed: buffer what the user says next, don't spot
    private var holdFrom = 0L                 // audio thread
    private var stoppedClean = false          // main thread: the audio thread ended before stop() returned

    /** Ask for a stage-2 check once [POST_MS] more audio has arrived. Called from the main thread. */
    fun requestVerify() { if (verifyAt < 0) { val s = seen; hitAt = s; verifyAt = s + POST_MS * RATE / 1000 } }

    /** The app is not acting on a PASS after all: go back to spotting. Called from the main thread. */
    fun resume() { holding = false }

    /**
     * The audio from just before the wake hit up to the moment the listener stopped: whatever the user said while
     * stage 2 was deciding ("hey hermes what time is it" in one breath). Call on the main thread after [stop].
     */
    fun takePreroll(): ShortArray? = if (stoppedClean && holding) preroll() else null

    private fun preroll(): ShortArray? {
        val end = seen
        val from = maxOf(hitAt - PRE_MS * RATE / 1000, end - RING, 0L)
        if (hitAt < 0 || end <= from) return null
        return ShortArray((end - from).toInt()) { ring[((from + it) % RING).toInt()] }
    }

    @SuppressLint("MissingPermission")
    fun start() {
        testWav?.let { f ->
            val input = f.inputStream().buffered().apply { skip(44) }
            val bytes = ByteArray(CHUNK * 2)
            running = true
            thread = Thread({
                loop({ buf ->
                    val n = input.read(bytes)
                    if (n <= 0) -1 else {
                        ByteBuffer.wrap(bytes, 0, n).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(buf, 0, n / 2)
                        Thread.sleep(n / 2 * 1000L / RATE); n / 2
                    }
                }, { 0 }, { input.close(); Log.i(TAG, "wake test done: ${f.name}") })
            }, "wake-audio").also { it.start() }
            return
        }
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBuf, MIC_BUF_MS * RATE / 1000 * 2))
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); throw IllegalStateException("AudioRecord init failed") }
        rec.startRecording()
        // Another client holding the mic makes startRecording() fail without throwing; read() then returns 0 forever.
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) { rec.release(); throw IllegalStateException("mic busy") }
        running = true
        thread = Thread({
            loop({ rec.read(it, 0, it.size) }, { rec.read(it, 0, it.size, AudioRecord.READ_NON_BLOCKING) },
                { runCatching { rec.stop() }; rec.release() })
        }, "wake-audio").also { it.start() }
    }

    fun stop() {
        running = false
        val t = thread
        if (t != null && t !== Thread.currentThread()) runCatching { t.join(1500) }
        stoppedClean = t != null && !t.isAlive
        thread = null
    }

    private fun append(buf: ShortArray, n: Int) {
        val s = seen
        for (i in 0 until n) ring[((s + i) % RING).toInt()] = buf[i]
        seen = s + n
    }

    /** [read] blocks for the next chunk; [drain] returns what is already queued without blocking (0 when empty). */
    private fun loop(read: (ShortArray) -> Int, drain: (ShortArray) -> Int, close: () -> Unit) {
        val buf = ShortArray(CHUNK)
        var emptyReads = 0
        try {
            while (running) {
                val n = read(buf)
                if (n < 0) { Log.w(TAG, "wake read $n"); break }
                if (n == 0) {   // a stopped/stolen mic returns 0 at once: don't spin a core, give up after ~1 s
                    if (++emptyReads > 100) { Log.w(TAG, "wake mic returned no audio"); break }
                    Thread.sleep(10)
                    continue
                }
                emptyReads = 0
                append(buf, n)
                if (holding) {
                    // Passed stage 2: the capture is about to take over. Keep the user's words in the ring until then.
                    val held = (seen - holdFrom) * 1000 / RATE
                    if (testWav != null && held >= 1500) { preroll()?.let { saveClip(it, "preroll") }; holding = false }
                    else if (held >= HOLD_MS) holding = false     // nobody collected it: back to spotting
                    continue
                }
                val at = verifyAt
                if (at >= 0) {
                    if (seen < at) continue                      // collecting the tail of the phrase
                    verifyAt = -1
                    verify()
                    spotter.reset()
                    continue
                }
                val final = spotter.acceptWaveForm(buf, n)
                val (field, json) = if (final) "text" to spotter.result else "partial" to spotter.partialResult
                val text = runCatching { JSONObject(json).optString(field) }.getOrDefault("")
                main.post { if (running) onText(text, field) }
            }
            // Stopped to hand over to the capture: also take what queued up in the mic buffer while stage 2 decoded.
            if (holding) for (k in 0 until MIC_BUF_MS * RATE / 1000 / CHUNK + 1) { val n = drain(buf); if (n <= 0) break; append(buf, n) }
        } catch (e: Exception) {
            Log.w(TAG, "wake loop", e)
        } finally {
            runCatching { close() }
            // Finalize: Vosk aborts the process (KaldiFatalError) on setGrammar() while the stream is "running".
            runCatching { spotter.finalResult }
        }
        if (running) { running = false; main.post(onError) }   // died on its own (mic taken / read error)
    }

    private fun verify() {
        val len = minOf((WINDOW_MS * RATE / 1000).toLong(), seen, RING.toLong()).toInt()   // seen passes 2^31 after 37 h
        val seg = ShortArray(len)
        val start = seen - len
        for (i in 0 until len) seg[i] = ring[((start + i) % RING).toInt()]
        val t0 = System.currentTimeMillis()
        verifier.reset()
        verifier.acceptWaveForm(seg, len)
        val r = runCatching { JSONObject(verifier.finalResult) }.getOrDefault(JSONObject())
        val alts = r.optJSONArray("alternatives")
        val texts = if (alts != null) (0 until alts.length()).map { alts.getJSONObject(it).optString("text") }
                    else listOf(r.optString("text"))
        val ok = texts.any { t -> t.split(' ').any { it in ACCEPT } }
        val heard = texts.take(3).joinToString(" | ")
        Log.i(TAG, "wake verify ${if (ok) "PASS" else "reject"} in ${System.currentTimeMillis() - t0} ms: $heard")
        saveClip(seg, if (ok) "pass" else "reject")
        if (ok) { holdFrom = seen; holding = true }
        main.post { if (running) onVerdict(ok, heard) }
    }

    /** Keep the last [KEEP_CLIPS] stage-1 windows on the device for tuning (`adb pull …/files/wake`). */
    private fun saveClip(seg: ShortArray, tag: String) {
        val dir = clipDir ?: return
        runCatching {
            dir.mkdirs()
            val f = File(dir, "${System.currentTimeMillis()}-$tag.wav")
            val bytes = seg.size * 2
            val bb = ByteBuffer.allocate(44 + bytes).order(ByteOrder.LITTLE_ENDIAN)
            bb.put("RIFF".toByteArray()).putInt(36 + bytes).put("WAVE".toByteArray())
            bb.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2).putShort(2).putShort(16)
            bb.put("data".toByteArray()).putInt(bytes)
            for (s in seg) bb.putShort(s)
            f.writeBytes(bb.array())
            dir.listFiles()?.sortedByDescending { it.name }?.drop(KEEP_CLIPS)?.forEach { it.delete() }
        }.onFailure { Log.w(TAG, "saveClip", it) }
    }
}
