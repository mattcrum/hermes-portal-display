# The voice bridge (`server/`)

A small FastAPI service that sits next to Hermes Agent. Per question it does three things:

```
audio from the Portal ──ffmpeg + faster-whisper──▶ text ──Hermes API server──▶ reply
reply ──▶ { speech, screen card, device actions } ──edge-tts──▶ mp3 back to the Portal
```

It keeps no state of its own. Hermes holds the conversation; the bridge passes a session id back and forth.

## Running it

| | |
|---|---|
| First-time setup | `./server/setup.sh` (creates `server/.venv` and `server/.env`; safe to re-run) |
| Foreground | `./server/run.sh` |
| At boot (Linux) | `./server/setup.sh --systemd`, then `journalctl -u portal-voice -f` for logs |
| Restart after changing `.env` | Ctrl-C and `./server/run.sh`, or `sudo systemctl restart portal-voice` |
| Upgrade | `git pull && ./server/setup.sh`, then restart |
| Health check | `curl http://localhost:8650/voice/health` |

The first start downloads the Whisper model (about 150 MB for `base`). The first question after a restart takes a few
seconds longer while it warms up.

On macOS there is no service installer; run `./server/run.sh` in a terminal, or wrap it in a launchd agent of your own.

## Settings (`server/.env`)

| Setting | Default | What it does |
|---|---|---|
| `HERMES_URL` | `http://127.0.0.1:8642` | Hermes Agent's API server |
| `HERMES_API_KEY` | (required) | Same value as Hermes' `API_SERVER_KEY` |
| `PORTAL_VOICE_KEY` | (required) | What the Portal must send. Any long random string |
| `BIND_HOST` | `0.0.0.0` | `0.0.0.0`: reachable on your network. `127.0.0.1`: only through a reverse proxy on this machine |
| `BIND_PORT` | `8650` | |
| `WHISPER_MODEL` | `base` | `tiny`, `base` or `small`. Bigger is more accurate and slower |
| `WHISPER_LANGUAGE` | `en` | Language code, or empty to auto-detect. The wake word itself is English only |
| `TTS_VOICE` | `en-US-AriaNeural` | Any edge-tts voice: `server/.venv/bin/edge-tts --list-voices` |
| `HERMES_TIMEOUT` | `180` | Seconds to wait for Hermes |
| `LOCAL_TZ` | `America/New_York` | Time zone for the clock, the agenda and "what time is it" (`setup.sh` fills in this machine's) |
| `PLACE_NAME` | `New York` | Label on the idle screen |
| `WEATHER_LAT`, `WEATHER_LON` | New York | Where the forecast is for |
| `WEATHER_UNITS` | `fahrenheit` | or `celsius` |
| `CALENDAR_ENABLED` | `auto` | See [Calendar](#calendar-optional) |
| `HERMES_CONFIG` | `~/.hermes/config.yaml` | Where the calendar's MCP server is read from |
| `CALENDAR_MCP` | `ms365` | Name of that server under `mcp_servers` |
| `NODE_BIN` | (empty) | Folder that holds `npx`, if the service can't find it on `PATH` |

Variables set in the real environment (a systemd unit, your shell) win over `.env`.

To change the key the Portal uses: edit `PORTAL_VOICE_KEY`, restart the bridge, and re-run
`./android/install.sh --url … --key-from server/.env` (or type the new key under the gear on the Portal).

## Hermes side

The bridge talks to Hermes' OpenAI-compatible endpoint (`/v1/chat/completions`), so Hermes needs its API server on:
`API_SERVER_ENABLED=true` and an `API_SERVER_KEY`. See the
[Hermes API server docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).

**Limit the toolset.** Anything said near the Portal becomes a prompt, and that includes the TV. Give the API
server a toolset without terminal, file, code, browser or delegation tools in `~/.hermes/config.yaml`:

```yaml
platform_toolsets:
  api_server: [web, memory, session_search, skills, todo, cronjob]
```

This applies to every client of Hermes' API server, not only the Portal.

## HTTPS and remote servers

On a home network, plain HTTP on port 8650 is fine: only your devices can reach it, and the Portal key still gates
every request.

If the bridge runs somewhere the internet can reach (a VPS, a port-forward), don't expose port 8650 directly:

1. Set `BIND_HOST=127.0.0.1` in `server/.env` and restart the bridge.
2. Put a TLS reverse proxy in front. With [Caddy](https://caddyserver.com), which gets certificates by itself:

   ```
   voice.example.com {
       handle /voice* {
           request_body {
               max_size 10MB
           }
           reverse_proxy 127.0.0.1:8650
       }
   }
   ```

3. Point the Portal at it: `./android/install.sh --url https://voice.example.com`.

Every route lives under `/voice`, so the proxy can forward that prefix as it is. Failed keys answer `401`, which
tools like fail2ban can watch for.

## Calendar (optional)

The idle screen can show today's and tomorrow's agenda. It reads it from the same Microsoft 365 MCP server Hermes
uses, if you have one: the bridge starts the server defined under `mcp_servers.ms365` in Hermes' `config.yaml` and
calls its `get-calendar-view` tool. That takes about 2 seconds, uses no LLM call and creates no Hermes session. Results
are cached for 5 minutes.

- `CALENDAR_ENABLED=auto` (the default): on if that MCP server is in Hermes' config, off otherwise.
- `true` / `false`: force it.
- If your server has another name, set `CALENDAR_MCP`. If `npx` isn't on the service's `PATH`, set `NODE_BIN`.

The screen sits in a room, so the bridge never lets meeting join links, meeting IDs or passcodes through. A link
becomes "Zoom" or "Teams"; IDs and passcodes are removed. The same filter runs over the cards Hermes writes.

Other calendars (Google, CalDAV) aren't built in. `_calendar_view()` in `server/app.py` is the one function to
replace: return a list of `{title, start, end, allDay, location, online}`.

## API

All routes are under `/voice`. Everything except the page and the health check needs `Authorization: Bearer <PORTAL_VOICE_KEY>`.

| Route | |
|---|---|
| `GET /voice/` | A push-to-talk web page (holds no secrets; asks for the key). Browsers only allow the microphone over HTTPS or on localhost |
| `GET /voice/health` | `{"ok":true,"whisper_loaded":true}` |
| `POST /voice/turn` | multipart `audio` (wav, webm, ogg, m4a) + optional `session_id` → a turn |
| `POST /voice/text` | JSON `{text, session_id}` → a turn (typed input, tapped suggestions) |
| `GET /voice/ambient` | `{place, tz, weather, agenda, agenda_error}` for the idle screen |

A turn is `{transcript, speech, display, actions, session_id, audio_b64, timings}`.

```bash
KEY=$(grep ^PORTAL_VOICE_KEY= server/.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
     -d '{"text":"What can you do?"}' http://localhost:8650/voice/text | python3 -m json.tool | head -20
```

### The reply contract

The bridge's system prompt asks Hermes for one to three spoken sentences, optionally followed by:

- `<display>markdown</display>`: a card for the screen (not spoken).
- `<action>{json}</action>`: something for the Portal to do. Known actions: `timer {seconds, label}`,
  `alarm {time: "HH:MM", label}`, `cancel_timers`, `volume {level: 0-10}`, `theme {mode: day|night|auto}`.

`split_reply()` strips the tags from the speech, drops unknown actions and malformed JSON, and passes the rest to the
Portal. The prompt is `VOICE_SYSTEM_PROMPT` at the top of `server/app.py`; edit it to change how Hermes talks.

### Conversation memory

Hermes' chat endpoint is stateless per request; sending the previous `X-Hermes-Session-Id` continues the server-side
session. The bridge returns `session_id`, the Portal keeps it for 10 minutes after the last turn, and
**New conversation** drops it.

### Weather

From [Open-Meteo](https://open-meteo.com): no key, cached for 10 minutes. If a fetch fails the last good forecast
stays on screen.

## Timing

Measured with Hermes on a 2-vCPU cloud VM: speech-to-text about 0.6 s, text-to-speech about 1 s, Hermes 2 to 11 s
depending on whether it uses a tool. Wake word to the start of the answer is about 4.5 s for a simple question.
Per-turn timings are in the bridge's log and at the bottom of the conversation screen.

Audio is decoded with the system `ffmpeg` instead of faster-whisper's PyAV path, which breaks across `av` releases.
