#!/usr/bin/env bash
# One-time setup for the voice bridge. Run it on the machine where Hermes Agent runs. Safe to re-run.
#
#   ./setup.sh             install dependencies, create .env with fresh keys
#   ./setup.sh --systemd   the same, then install and start a systemd service (Linux; asks for sudo)
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\nError: %s\n' "$*" >&2; exit 1; }

SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --systemd) SYSTEMD=1 ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

step "Checking prerequisites"
PY=${PYTHON:-python3}
command -v "$PY" >/dev/null || die "python3 not found. Install Python 3.10 or newer."
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || die "Python 3.10 or newer is needed ($("$PY" -V) found). Set PYTHON=/path/to/python3.12 and re-run."
command -v ffmpeg >/dev/null || die "ffmpeg not found. Install it: 'brew install ffmpeg' (macOS) or 'sudo apt install ffmpeg' (Debian/Ubuntu)."
echo "$("$PY" -V), ffmpeg: ok"

step "Installing Python packages into server/.venv (a few minutes the first time)"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt
echo "ok"

# set_env KEY VALUE: replace the KEY= line in .env
set_env() {
  .venv/bin/python - "$1" "$2" <<'PY'
import sys
key, value = sys.argv[1], sys.argv[2]
lines = open(".env").read().splitlines()
out, done = [], False
for line in lines:
    if line.startswith(key + "="):
        out.append(f"{key}={value}"); done = True
    else:
        out.append(line)
if not done:
    out.append(f"{key}={value}")
open(".env", "w").write("\n".join(out) + "\n")
PY
}
get_env() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true; }

step "Settings (.env)"
if [ ! -f .env ]; then
  ( umask 077; cp .env.example .env )
  set_env PORTAL_VOICE_KEY "$(.venv/bin/python -c 'import secrets; print(secrets.token_hex(24))')"
  tz=$(.venv/bin/python -c 'import os; p = os.path.realpath("/etc/localtime"); print(p.split("zoneinfo/")[-1] if "zoneinfo/" in p else "")')
  [ -n "$tz" ] && set_env LOCAL_TZ "$tz"
  echo "Created .env with a new Portal key${tz:+ and time zone $tz}."
else
  echo "Keeping your existing .env."
fi
chmod 600 .env

HERMES_ENV="${HERMES_HOME:-$HOME/.hermes}/.env"
NEED_HERMES=0
if [ -z "$(get_env HERMES_API_KEY .env)" ]; then
  hk=$(get_env API_SERVER_KEY "$HERMES_ENV")
  # Hermes also accepts the key in config.yaml (gateway.api_server.key)
  [ -n "$hk" ] || hk=$(.venv/bin/python - "${HERMES_HOME:-$HOME/.hermes}/config.yaml" <<'PY' 2>/dev/null || true
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1])) or {}
print(((cfg.get("gateway") or {}).get("api_server") or {}).get("key") or "")
PY
)
  if [ -n "$hk" ]; then
    set_env HERMES_API_KEY "$hk"
    echo "Copied Hermes' API key from your Hermes config."
  else
    NEED_HERMES=1
  fi
fi

if [ "$SYSTEMD" = 1 ] && [ "$NEED_HERMES" = 0 ]; then
  step "Installing the systemd service (sudo)"
  command -v systemctl >/dev/null || die "systemctl not found. --systemd is for Linux; on macOS use ./run.sh."
  sed -e "s|__USER__|$(id -un)|g" -e "s|__DIR__|$PWD|g" portal-voice.service | sudo tee /etc/systemd/system/portal-voice.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now portal-voice
  sudo systemctl restart portal-voice
  echo "Started. Logs: journalctl -u portal-voice -f"
fi

IP=$(.venv/bin/python - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("192.0.2.1", 9)); print(s.getsockname()[0])   # no packet is sent; this only picks the outgoing interface
except OSError:
    print("THIS-MACHINE'S-IP")
PY
)
PORT=$(get_env BIND_PORT .env); PORT=${PORT:-8650}

step "Next steps"
if [ "$NEED_HERMES" = 1 ]; then
  cat <<TXT
Hermes' API server key was not found in $HERMES_ENV.

  1. Turn the API server on (once):
       hermes config set API_SERVER_ENABLED true
       hermes config set API_SERVER_KEY "\$(openssl rand -hex 32)"
     then restart the Hermes gateway.
  2. Run ./server/setup.sh again (it copies the key), or paste the key into server/.env as HERMES_API_KEY.
TXT
  exit 1
fi
cat <<TXT
1. Set your town for the weather: edit PLACE_NAME, WEATHER_LAT, WEATHER_LON (and WEATHER_UNITS) in server/.env
2. Start the bridge:        ./server/run.sh     (to run it at boot on Linux: ./server/setup.sh --systemd)
3. Check it from here:      curl http://localhost:$PORT/voice/health
4. Install the Portal app (from a computer with the Portal on USB):
       ./android/install.sh --url http://$IP:$PORT
   It asks for the Portal key. To print it:   grep ^PORTAL_VOICE_KEY= server/.env
   If the Portal is plugged into this machine: ./android/install.sh --url http://$IP:$PORT --key-from server/.env
(Paths are from the repo folder. Full walkthrough: README.md)
TXT
