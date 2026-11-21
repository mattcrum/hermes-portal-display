# hermes-portal-display

A Meta Portal turned into an Echo-style smart display ("Hermes Display") for Hermes Agent. `README.md` is the
install guide; `docs/` holds the reference. Read the relevant doc before changing things.

- `android/`: native Kotlin app `io.github.mattcrum.hermesdisplay` (Vosk wake word, capture, timers) with a bundled
  WebView UI in `app/src/main/assets/ui/` (`app.js` sky + state, `art.js` dither + seal character, `app.css`).
  `install.sh` installs a release or a local build on a Portal over adb. See `docs/portal.md`.
- `server/`: the FastAPI voice bridge (`app.py`), with `setup.sh` / `run.sh` and a systemd template. See `docs/bridge.md`.
- `docs/wake-word.md`: the two-stage wake word (why, invariants, measurements, tuning knobs). Read it before touching
  wake detection; `android/tools/wake_harness.py` reproduces the numbers offline.
- `docs/design.md`: the screen, and the performance rules below in more detail.

## Everyday commands

```bash
export JAVA_HOME=$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home
cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
python3 -m http.server -d android/app/src/main/assets/ui 8765     # UI mock: http://localhost:8765/#scene=ambient&theme=day
./server/run.sh                                                    # bridge in the foreground (reads server/.env)
adb pull /sdcard/Android/data/io.github.mattcrum.hermesdisplay/files/health ./health   # freeze recorder logs
```

## Rules

- **This repo is public.** No real hostnames, IPs, device serials, calendar entries or names in code, docs, mock data
  or commit messages. Machine-specific notes go in `CLAUDE.local.md` (git-ignored); secrets live only in `server/.env`.
- **Secrets never go in chat, files, URLs, or typed into the Portal by an assistant.** Hand the user a command that
  reads the key itself, e.g. `./android/install.sh --url … --key-from server/.env` or `--key-ssh user@host:/path/.env`.
- The wing mark and `ui/seal.svg` are Nous Research's artwork, included with their OK. Don't relicense or restyle them.
- **No Home Assistant** in the voice pipeline; it could only ever be a Hermes tool.
- The voice session should keep a **restricted toolset** (`platform_toolsets.api_server`: no terminal/file/code/browser).
- Never put meeting URLs, meeting IDs or passcodes on screen (`scrub()` / `scrub_display()` in `server/app.py`).
- Release APKs must be signed with the same key every time, or nobody can upgrade in place (`docs/portal.md`).

## Performance on the Portal WebView

Every infinite CSS animation forces 60 Hz full redraws of the app view (~60% of the main thread). Keep all motion
in the canvas loop (15 fps ambient, 30 fps convo/comet, dither 8 fps) and batch strokes. Profile the right
process: the renderer is `com.facebook.portal.webview:sandboxed_process0`, not Chrome. Remote-debug with
`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` and drive `window.HV` over CDP.
