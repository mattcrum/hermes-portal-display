#!/usr/bin/env bash
# Install Hermes Display on a Meta Portal over USB (adb) and point it at your voice bridge.
#
#   ./android/install.sh --url http://192.168.1.50:8650            download the latest release and install it
#   ./android/install.sh --url ... --key-from server/.env          read the Portal key from a bridge .env file
#   ./android/install.sh --url ... --key-ssh me@server:/path/.env  read it from the bridge machine over ssh
#   ./android/install.sh --url ... --build                         build the app from this checkout instead
#   ./android/install.sh --url ... --apk my.apk                    install an APK you already have
#   ./android/install.sh --url ... --home                          also make it the Portal's home screen (no prompt)
#
# Without --key-from / --key-ssh it asks for the key (typing is hidden). Re-run any time to upgrade.
set -euo pipefail

PKG=io.github.mattcrum.hermesdisplay
RELEASE_APK=https://github.com/mattcrum/hermes-portal-display/releases/latest/download/hermes-display.apk
META_HOME=com.facebook.alohaapps.launcher/com.facebook.aloha.app.home.touch.HomeActivity
HERE=$(cd "$(dirname "$0")" && pwd)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\nError: %s\n' "$*" >&2; exit 1; }

URL="" APK="" BUILD=0 HOME_MODE=ask KEY_FILE="" KEY_SSH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL=${2:-}; shift 2 ;;
    --apk) APK=${2:-}; shift 2 ;;
    --key-from) KEY_FILE=${2:-}; shift 2 ;;
    --key-ssh) KEY_SSH=${2:-}; shift 2 ;;
    --build) BUILD=1; shift ;;
    --home) HOME_MODE=yes; shift ;;
    --no-home) HOME_MODE=no; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- the Portal
step "Looking for the Portal"
command -v adb >/dev/null || die "adb not found. Install it: 'brew install --cask android-platform-tools' (macOS) or 'sudo apt install adb' (Linux)."
adb start-server >/dev/null 2>&1 || true
DEVICES=$(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
COUNT=$(printf '%s\n' "$DEVICES" | grep -c . || true)
if [ "$COUNT" = 0 ]; then
  adb devices
  die "no device. On the Portal: Settings > Debug > ADB Enabled, plug a USB-C *data* cable into the Portal, and tap
'Allow USB debugging' on its screen. 'unauthorized' above means that prompt is still waiting. See docs/portal.md."
fi
if [ "$COUNT" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
  adb devices
  die "more than one device. Pick one: ANDROID_SERIAL=<serial> $0 ..."
fi
echo "Found: $(adb shell getprop ro.product.model | tr -d '\r') (Android $(adb shell getprop ro.build.version.release | tr -d '\r'))"

# ---------------------------------------------------------------- the APK
if [ "$BUILD" = 1 ]; then
  step "Building from source"
  cd "$HERE"
  if [ ! -d app/src/main/assets/model-en-us ]; then
    echo "Fetching the wake-word model (Vosk small-en-us, 40 MB download)"
    curl -fL --progress-bar -o vosk-model.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
    unzip -q vosk-model.zip && rm vosk-model.zip
    mv vosk-model-small-en-us-0.15 app/src/main/assets/model-en-us
    echo vosk-model-small-en-us-0.15 > app/src/main/assets/model-en-us/uuid
  fi
  if [ ! -f local.properties ] && [ -z "${ANDROID_HOME:-}" ]; then
    for sdk in /opt/homebrew/share/android-commandlinetools /usr/local/share/android-commandlinetools "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
      [ -d "$sdk" ] && { echo "sdk.dir=$sdk" > local.properties; break; }
    done
    [ -f local.properties ] || die "Android SDK not found. See 'Build from source' in docs/portal.md."
  fi
  if [ -z "${JAVA_HOME:-}" ] && command -v brew >/dev/null && brew --prefix openjdk@17 >/dev/null 2>&1; then
    export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
  fi
  ./gradlew --quiet assembleRelease
  APK="$HERE/app/build/outputs/apk/release/app-release.apk"
  cd - >/dev/null
elif [ -z "$APK" ]; then
  step "Downloading the latest release"
  APK=$(mktemp -d)/hermes-display.apk
  curl -fL --progress-bar -o "$APK" "$RELEASE_APK" || die "download failed. Get hermes-display.apk from the Releases page and pass --apk, or use --build."
fi
[ -f "$APK" ] || die "APK not found: $APK"

step "Installing"
if ! OUT=$(adb install -r "$APK" 2>&1); then
  echo "$OUT"
  case "$OUT" in
    *INSTALL_FAILED_UPDATE_INCOMPATIBLE*|*"signatures do not match"*)
      die "a copy signed with a different key is installed (a build of your own, or the other way round).
Remove it and re-run:  adb uninstall $PKG" ;;
    *) die "adb install failed" ;;
  esac
fi
adb shell pm grant $PKG android.permission.RECORD_AUDIO
adb shell pm grant $PKG android.permission.READ_LOGS 2>/dev/null || true   # optional: lets the freeze recorder keep system logs
echo "Installed."

# ---------------------------------------------------------------- bridge URL + key
step "Connecting it to your bridge"
if [ -z "$URL" ]; then
  printf 'Bridge URL (for example http://192.168.1.50:8650): '
  read -r URL
fi
[ -n "$URL" ] || die "a bridge URL is needed (--url http://<server-ip>:8650)"
case "$URL" in *[\ \'\"\;\&\|\$\`\\]*) die "that URL has characters I can't pass to the Portal" ;; esac

unquote() { sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
KEY=""
if [ -n "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || die "no such file: $KEY_FILE"
  KEY=$(grep -E '^PORTAL_VOICE_KEY=' "$KEY_FILE" | tail -1 | cut -d= -f2- | unquote)
elif [ -n "$KEY_SSH" ]; then
  KEY=$(ssh "${KEY_SSH%%:*}" "grep -E '^PORTAL_VOICE_KEY=' '${KEY_SSH#*:}'" | tail -1 | cut -d= -f2- | unquote)
else
  printf 'Portal key (PORTAL_VOICE_KEY from server/.env; typing is hidden): '
  read -rs KEY; echo
fi
[ -n "$KEY" ] || die "no key given"
case "$KEY" in *[!A-Za-z0-9._~+/=-]*) die "the key has characters I can't pass to the Portal; use letters and digits (openssl rand -hex 24)" ;; esac

HEALTH="${URL%/}"; case "$HEALTH" in */voice) ;; *) HEALTH="$HEALTH/voice" ;; esac
if curl -fsS --max-time 5 "$HEALTH/health" >/dev/null 2>&1; then
  echo "Bridge answers at $HEALTH"
else
  echo "Warning: no answer from $HEALTH/health from this computer. Check the bridge is running and the address is right."
  echo "         (Continuing: the Portal may still reach it.)"
fi

adb shell am start -n $PKG/.MainActivity --es base_url "$URL" --es key "$KEY" >/dev/null
echo "Sent the URL and key to the app."

# ---------------------------------------------------------------- home screen
if [ "$HOME_MODE" = ask ]; then
  printf '\nMake Hermes the Portal'"'"'s home screen, so it starts at boot? You can undo this any time. [y/N] '
  read -r ans
  case "$ans" in y|Y|yes) HOME_MODE=yes ;; *) HOME_MODE=no ;; esac
fi
if [ "$HOME_MODE" = yes ]; then
  adb shell cmd package set-home-activity $PKG/.MainActivity >/dev/null
  echo "Hermes is now the home screen. To go back to Meta's:"
  echo "  adb shell cmd package set-home-activity $META_HOME"
fi

step "Done"
cat <<TXT
Make sure the Portal's mic isn't muted (a crossed-out mic in its status bar means muted), then say "Hey Hermes".
If the screen shows an error, see "Troubleshooting" in the README.
TXT
