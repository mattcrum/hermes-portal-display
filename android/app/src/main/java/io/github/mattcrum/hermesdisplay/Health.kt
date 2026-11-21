package io.github.mattcrum.hermesdisplay

import android.content.Context
import android.os.Debug
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Flight recorder for "the Portal froze" — evidence that survives the power-cycle.
 *
 * Everything goes to /sdcard/Android/data/io.github.mattcrum.hermesdisplay/files/health/ (pull with `adb pull`, no run-as):
 *  health.log      one line a minute: memory, swap, app heap, threads, fds, hottest thermal zone, main-thread lag;
 *                  plus BOOT / MAIN BLOCKED (with the main thread's stack) / RENDERER GONE events
 *  logcat.txt*     rolling system log at Info+ (needs `adb shell pm grant io.github.mattcrum.hermesdisplay android.permission.READ_LOGS`;
 *                  without it, only this app's own lines). Rotated 10 x 2 MB.
 *  prev-<time>/     earlier runs' logcat files, moved aside on start so a reboot doesn't overwrite them (3 kept).
 */
class Health(ctx: Context, private val stateFn: () -> String) {
    private val dir = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "health").apply { mkdirs() }
    private val logFile = File(dir, "health.log")
    private val thread = HandlerThread("health").apply { start() }
    private val h = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private val fmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
    private var logcat: Process? = null

    @Volatile private var pingSent = 0L       // elapsedRealtime when the main-thread ping was posted, 0 = answered
    @Volatile private var maxLag = 0L          // worst main-thread lag since the last stats line
    private var blockedLogged = false
    private var ticks = 0

    fun start() {
        startLogcat()
        event("BOOT app start, device up ${SystemClock.elapsedRealtime() / 60000} min")
        h.post(tick)
    }

    fun stop() {
        h.removeCallbacksAndMessages(null)
        logcat?.destroy()
        thread.quitSafely()
    }

    fun event(msg: String) {
        Log.w("PortalVoice", "health: $msg")
        h.post { append("${fmt.format(Date())} $msg") }
    }

    private val tick = object : Runnable {
        override fun run() {
            val now = SystemClock.elapsedRealtime()
            val sent = pingSent
            if (sent != 0L && now - sent > 5000) {
                if (!blockedLogged) {
                    blockedLogged = true
                    val stack = Looper.getMainLooper().thread.stackTrace.take(25).joinToString("\n    at ")
                    append("${fmt.format(Date())} MAIN BLOCKED ${(now - sent) / 1000}s state=${stateFn()}\n    at $stack")
                }
            } else {
                if (sent == 0L) {
                    blockedLogged = false
                    val posted = now
                    pingSent = posted
                    main.post { val lag = SystemClock.elapsedRealtime() - posted; if (lag > maxLag) maxLag = lag; pingSent = 0L }
                }
            }
            if (ticks++ % 12 == 0) stats()          // tick is 5 s -> stats once a minute
            h.postDelayed(this, 5000)
        }
    }

    private fun stats() {
        val mi = meminfo()
        val rt = Runtime.getRuntime()
        val javaMb = (rt.totalMemory() - rt.freeMemory()) shr 20
        val nativeMb = Debug.getNativeHeapAllocatedSize() shr 20
        val pssMb = Debug.getPss() shr 10
        val threads = File("/proc/self/status").takeIf { it.canRead() }?.readLines()
            ?.firstOrNull { it.startsWith("Threads:") }?.substringAfter(":")?.trim() ?: "?"
        val fds = File("/proc/self/fd").list()?.size ?: -1
        append(
            "${fmt.format(Date())} up=${SystemClock.elapsedRealtime() / 60000}m avail=${mi["MemAvailable"]}M " +
                "swap=${(mi["SwapTotal"] ?: 0) - (mi["SwapFree"] ?: 0)}M pss=${pssMb}M java=${javaMb}M native=${nativeMb}M " +
                "threads=$threads fds=$fds hot=${hottest()} lag=${maxLag}ms state=${stateFn()}"
        )
        maxLag = 0
    }

    private fun meminfo(): Map<String, Long> = try {
        File("/proc/meminfo").readLines().associate {
            val p = it.split(Regex("\\s+")); p[0].trimEnd(':') to ((p.getOrNull(1)?.toLongOrNull() ?: 0L) shr 10)
        }
    } catch (e: Exception) { emptyMap() }

    /** Hottest thermal zone as "type:°C" (zones report m°C or °C depending on driver). */
    private fun hottest(): String {
        var best = "?"; var bestC = -999.0
        File("/sys/class/thermal").listFiles { f -> f.name.startsWith("thermal_zone") }?.forEach { z ->
            val raw = try { File(z, "temp").readText().trim().toDouble() } catch (e: Exception) { return@forEach }
            val c = if (raw > 1000) raw / 1000 else if (raw > 200) raw / 10 else raw
            if (c in 1.0..150.0 && c > bestC) { bestC = c; best = (try { File(z, "type").readText().trim() } catch (e: Exception) { z.name }) + ":" + c.toInt() }
        }
        return best
    }

    private fun append(line: String) {
        try {
            if (logFile.length() > 2_000_000) logFile.renameTo(File(dir, "health.1.log"))
            logFile.appendText(line + "\n")
        } catch (e: Exception) { Log.w("PortalVoice", "health write failed: ${e.message}") }
    }

    private fun startLogcat() {
        try {
            // Move the last run's capture aside (prev-<time>/), keeping the 3 newest, so neither a reboot nor a
            // reinstall overwrites the log from just before a freeze.
            val current = dir.listFiles { f -> f.name.startsWith("logcat.txt") }.orEmpty()
            if (current.isNotEmpty()) {
                val prev = File(dir, "prev-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())).apply { mkdirs() }
                current.forEach { it.renameTo(File(prev, it.name)) }
                dir.listFiles { f -> f.isDirectory && f.name.startsWith("prev-") }.orEmpty()
                    .sortedByDescending { it.name }.drop(3).forEach { it.deleteRecursively() }
            }
            logcat = ProcessBuilder("logcat", "-v", "threadtime", "-f", File(dir, "logcat.txt").path,
                "-r", "2048", "-n", "10", "*:I").redirectErrorStream(true).start()
        } catch (e: Exception) { Log.w("PortalVoice", "logcat capture failed: ${e.message}") }
    }
}
