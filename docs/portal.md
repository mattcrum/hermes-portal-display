# The Portal app (`android/`)

A native Kotlin app (`io.github.mattcrum.hermesdisplay`, minSdk 28, one activity, no AndroidX). Native code owns the
microphone, the wake word, the network, audio and timers. The screen is a bundled web page in a full-screen WebView
(`android/app/src/main/assets/ui/`), driven through `window.HV.*` and calling back through `window.Native.*`. The
voice key stays on the native side and never reaches JavaScript.

```
WAKE      Vosk small-en-us (offline) listens for "hey hermes"; a second, full-vocabulary pass confirms it
LISTENING AudioRecord 16 kHz + energy VAD (1.2 s of trailing silence ends it, 30 s max)
THINKING  POST speech.wav → the bridge's /voice/turn
SPEAKING  plays the mp3; if the reply ends in "?", the mic re-opens once (no wake word needed)
```

## The device this was built on

| | |
|---|---|
| Model | Portal 10" 1st gen (`ro.product.device=aloha`) |
| OS | Android 9 (API 28), arm64-v8a, 3.8 GB RAM, 1280×800 @160dpi |
| Chip | Snapdragon 835, 8 cores: on-device wake-word detection is cheap |
| WebView | `com.facebook.portal.webview` |
| No Google services | Android's `SpeechRecognizer` isn't available, so speech-to-text runs on the bridge |

Other Portal models haven't been tried. If you run it on one, an issue or PR with what you found is welcome.

## Connecting ADB

1. Portal: **Settings → Debug → ADB Enabled**.
2. Use a USB-C **data** cable (many are charge-only) in the Portal's USB-C port. Plug straight into the computer the
   first time, not through a hub.
3. Accept **Allow USB debugging** on the Portal's screen.
4. `adb devices` should show one line ending in `device`.

If the computer sees a "Portal" USB device but `adb devices` is empty, the Portal isn't exposing the ADB interface yet.
Toggle ADB off and on **while it's plugged in**, replug, and accept the prompt. `unauthorized` means the prompt is
still waiting on the Portal's screen.

Wireless ADB afterwards, until the next reboot: `adb tcpip 5555 && adb connect <portal-ip>:5555`.

## Home screen

```bash
adb shell cmd package set-home-activity io.github.mattcrum.hermesdisplay/.MainActivity      # Hermes at boot
adb shell cmd package set-home-activity com.facebook.alohaapps.launcher/com.facebook.aloha.app.home.touch.HomeActivity   # back to Meta's
```

No Meta package is disabled or removed. While Hermes is HOME, Meta's launcher can't be opened: it starts and bounces
straight back. To use Portal calling or Meta's apps, switch back with the second command.

The screen stays on because the app holds `FLAG_KEEP_SCREEN_ON`. (The Portal's device policy resets
`stay_on_while_plugged_in`, so `svc power stayon` doesn't stick.)

## Settings by intent

Everything under the gear can also be set from the computer:

```bash
adb shell am start -n io.github.mattcrum.hermesdisplay/.MainActivity --es base_url "http://192.168.1.50:8650" --es key "…"
adb shell am start -n io.github.mattcrum.hermesdisplay/.MainActivity --es wake "hey hermes"
adb shell "am start -n io.github.mattcrum.hermesdisplay/.MainActivity --es ask 'Set a 10 minute timer'"   # run a typed question
```

- `base_url` accepts `http://host:8650`; the app adds `/voice` when the URL has no path.
- Changing `base_url` by intent without a `key` clears the stored key, so another app on the Portal can't redirect
  your key to a different server.
- A custom wake phrase works, but only phrases containing "hermes" get the second verification stage. See
  [wake-word.md](wake-word.md).

## Build from source

You need JDK 17 and the Android SDK (platform 35, build-tools 35). On macOS:

```bash
brew install openjdk@17
brew install --cask android-commandlinetools android-platform-tools
sdkmanager "platforms;android-35" "build-tools;35.0.0"
```

Then build and install in one go:

```bash
./android/install.sh --build --url http://192.168.1.50:8650
```

`--build` fetches the wake-word model (it isn't in the repo), finds the SDK, runs `./gradlew assembleRelease` and
installs the result. A build of your own is signed with your machine's debug key, not the release's, so the first time
you switch between the two you have to `adb uninstall io.github.mattcrum.hermesdisplay` first.

By hand, for development:

```bash
cd android
curl -LO https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip && unzip -q vosk-model-small-en-us-0.15.zip
mv vosk-model-small-en-us-0.15 app/src/main/assets/model-en-us
echo vosk-model-small-en-us-0.15 > app/src/main/assets/model-en-us/uuid
echo "sdk.dir=/opt/homebrew/share/android-commandlinetools" > local.properties
export JAVA_HOME=$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant io.github.mattcrum.hermesdisplay android.permission.RECORD_AUDIO
```

Debug builds turn on WebView remote debugging (`chrome://inspect`) and the wake-word replay hook.

**Cutting a release:** bump `versionCode` and `versionName` in `android/app/build.gradle.kts`, run
`./gradlew assembleRelease`, and attach `app/build/outputs/apk/release/app-release.apk` to a GitHub release under the
name `hermes-display.apk` (the install script downloads that name from the latest release). Releases have to be signed
with the same key every time, or nobody can upgrade in place.

## Preview the screen without a Portal

The UI runs with mock data in any desktop browser:

```bash
python3 -m http.server -d android/app/src/main/assets/ui 8765
```

Open `http://localhost:8765/#scene=ambient&theme=day` in a 1280×800 window. Scenes: `ambient`, `listening`,
`thinking`, `card`, `ring`, `settings`, `sleep`. Themes: `day`, `night`. Keys: `l` listen, `r` ring, `n` switch theme.

## Logs

```bash
adb logcat -s PortalVoice:I VoskAPI       # states, wake candidates and verdicts, errors
```

### Freeze recorder

A Portal can hard-freeze after days of uptime, and the power-cycle wipes every system log. So the app keeps its own
evidence on shared storage, where a reboot doesn't touch it (`Health.kt`):

- `health.log`: one line a minute (free memory, swap, app heap, threads, file descriptors, hottest thermal zone, worst
  main-thread lag, state), plus events: `BOOT`, `MAIN BLOCKED` (over 5 s, with the main thread's stack) and
  `RENDERER GONE` (the WebView renderer died; the activity rebuilds itself instead of crashing).
- `logcat.txt*`: a rolling system log at Info and above (10 × 2 MB). Each start moves the previous run's capture to
  `prev-<time>/` (3 kept), so the log from just before a freeze survives.

```bash
adb shell pm grant io.github.mattcrum.hermesdisplay android.permission.READ_LOGS   # once per install; without it, app-only logs
adb pull /sdcard/Android/data/io.github.mattcrum.hermesdisplay/files/health ./health
```

After a freeze: power-cycle, pull, and read the end of `health.log` and the newest `prev-*/logcat.txt`.

## Profiling on the device

The renderer process is `com.facebook.portal.webview:sandboxed_process0`, not Chrome. To drive the page on the device
from a desktop (debug builds):

```bash
adb shell pidof io.github.mattcrum.hermesdisplay
adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
```

Then open `chrome://inspect`, or talk CDP to port 9333 and call `window.HV.*` to stage states. See
[design.md](design.md#performance-on-the-portals-webview) for what to watch.
