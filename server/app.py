"""portal-voice: speech + display bridge between a Meta Portal and Hermes.

Flow per turn:  audio --(ffmpeg, faster-whisper)--> text --(Hermes API server)--> reply
                reply --> {speech, display markdown, device actions} --(edge-tts)--> mp3

Routes (all under /voice so a reverse proxy can forward the prefix as-is):
  GET  /voice/          push-to-talk web client (public page; holds no secrets)
  GET  /voice/health    liveness
  POST /voice/turn      multipart: audio=<file>, session_id=<optional>   (Bearer PORTAL_VOICE_KEY)
  POST /voice/text      json: {"text": "...", "session_id": "..."}       (Bearer PORTAL_VOICE_KEY)
  GET  /voice/ambient   weather + today's/tomorrow's agenda for the idle screen (Bearer)

Turn responses: {transcript, reply, speech, display, actions[], session_id, audio_b64, timings}.
Conversation continuity: the client echoes session_id (sent upstream as X-Hermes-Session-Id).

Run it with `python app.py` (reads .env next to this file), or see README "Install".
"""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import hmac
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import edge_tts
import httpx
import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from faster_whisper import WhisperModel
from pydantic import BaseModel

log = logging.getLogger("portal-voice")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _load_dotenv(path: Path) -> None:
    """Read KEY=VALUE lines from .env beside this file. Variables already in the environment win (systemd, shell)."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        os.environ.setdefault(k.strip(), v)


_load_dotenv(Path(__file__).parent / ".env")


def _need(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"{name} is not set. Run ./setup.sh, or fill it in server/.env (see .env.example).")
    return v


HERMES_URL = os.environ.get("HERMES_URL", "http://127.0.0.1:8642").rstrip("/")
HERMES_API_KEY = _need("HERMES_API_KEY")
PORTAL_VOICE_KEY = _need("PORTAL_VOICE_KEY")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en") or None
TTS_VOICE = os.environ.get("TTS_VOICE", "en-US-AriaNeural")
HERMES_TIMEOUT = float(os.environ.get("HERMES_TIMEOUT", "180"))
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", str(8 * 1024 * 1024)))
MAX_TTS_CHARS = int(os.environ.get("MAX_TTS_CHARS", "1200"))

# Ambient screen
LOCAL_TZ = os.environ.get("LOCAL_TZ", "America/New_York")
PLACE_NAME = os.environ.get("PLACE_NAME", "New York")
WEATHER_LAT = float(os.environ.get("WEATHER_LAT", "40.7128"))
WEATHER_LON = float(os.environ.get("WEATHER_LON", "-74.0060"))
WEATHER_UNITS = os.environ.get("WEATHER_UNITS", "fahrenheit")  # or celsius
HERMES_CONFIG = os.path.expanduser(os.environ.get("HERMES_CONFIG", "~/.hermes/config.yaml"))
NODE_BIN = os.environ.get("NODE_BIN", "")  # dir with npx (Hermes ships its own node)
CALENDAR_MCP = os.environ.get("CALENDAR_MCP", "ms365")  # name of the server under mcp_servers in HERMES_CONFIG


def _calendar_enabled(setting: str) -> bool:
    """true / false, or auto: on only when Hermes has the calendar MCP server configured."""
    setting = setting.strip().lower()
    if setting in ("true", "false"):
        return setting == "true"
    try:
        import yaml
        with open(HERMES_CONFIG) as f:
            return CALENDAR_MCP in ((yaml.safe_load(f) or {}).get("mcp_servers") or {})
    except Exception:  # noqa: BLE001  (no Hermes config here, or unreadable: no agenda)
        return False


CALENDAR_ENABLED = _calendar_enabled(os.environ.get("CALENDAR_ENABLED", "auto"))

VOICE_SYSTEM_PROMPT = """You are Hermes, speaking through a smart display (a Meta Portal with a 10-inch screen and a \
speaker) in the user's home. Local time is {now} ({tz}).

How to answer:
1. SPEECH (required, first): one to three short, natural spoken sentences. It is read aloud by text-to-speech, so no \
markdown, lists, emoji, or URLs.
2. SCREEN (optional): when something is worth seeing (a list, schedule, steps, numbers, a comparison, a recipe), append \
<display>concise GitHub-flavored markdown: a short "# Title", then bullets or a small table</display>. Keep it \
scannable; do not repeat the spoken sentences verbatim; no URLs unless asked. The screen is visible to everyone in the \
room: never show meeting join links, meeting IDs or passcodes, even if asked.
3. DEVICE ACTIONS (optional): this display runs its own timers and alarms, sets its own volume, and switches its \
screen theme. When the user asks for any of these (including "night mode", "dark mode", "light mode" or "back to \
automatic" for the theme), append one tag per action and confirm it briefly in speech (do not use your cronjob tool \
for these):
   <action>{{"type":"timer","seconds":600,"label":"Pasta"}}</action>
   <action>{{"type":"alarm","time":"07:30","label":"Wake up"}}</action>   (24-hour local time)
   <action>{{"type":"cancel_timers"}}</action>
   <action>{{"type":"volume","level":6}}</action>   (0 to 10)
   <action>{{"type":"theme","mode":"night"}}</action>   (day, night, or auto)
Never read the tags aloud or mention them."""

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="portal-voice", docs_url=None, redoc_url=None, openapi_url=None)
_whisper: WhisperModel | None = None
_whisper_lock = asyncio.Lock()


def require_key(authorization: str = Header(default="")) -> None:
    token = authorization.removeprefix("Bearer ").strip()
    if not token or not hmac.compare_digest(token, PORTAL_VOICE_KEY):
        raise HTTPException(status_code=401, detail="invalid key")


@app.on_event("startup")
async def _load_model() -> None:
    global _whisper
    t = time.monotonic()
    _whisper = await asyncio.to_thread(WhisperModel, WHISPER_MODEL, device="cpu", compute_type="int8")
    log.info("whisper %s loaded in %.1fs", WHISPER_MODEL, time.monotonic() - t)


# ------------------------------------------------------------------ speech to text

def _decode(path: str):
    """Decode any container/codec (webm/opus, ogg, m4a, wav) to 16 kHz mono float32 via ffmpeg.

    Done here rather than via faster-whisper's PyAV path, which breaks across av releases.
    """
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    return np.frombuffer(out, np.int16).astype(np.float32) / 32768.0


def _transcribe_sync(path: str) -> str:
    assert _whisper is not None
    samples = _decode(path)
    if samples.size < 16000 * 0.3:  # under 0.3 s: nothing to hear
        return ""
    segments, _info = _whisper.transcribe(
        samples,
        language=WHISPER_LANGUAGE,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return " ".join(s.text.strip() for s in segments).strip()


async def transcribe(data: bytes, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as f:
        f.write(data)
        f.flush()
        async with _whisper_lock:  # 2 vCPU box: one transcription at a time
            return await asyncio.to_thread(_transcribe_sync, f.name)


# ------------------------------------------------------------------ Hermes

async def ask_hermes(text: str, session_id: str | None) -> tuple[str, str | None]:
    headers = {"Authorization": f"Bearer {HERMES_API_KEY}"}
    if session_id:
        headers["X-Hermes-Session-Id"] = session_id
    now = dt.datetime.now(ZoneInfo(LOCAL_TZ))
    body = {
        "model": "hermes-agent",
        "messages": [
            {"role": "system", "content": VOICE_SYSTEM_PROMPT.format(now=now.strftime("%A %d %B %Y, %H:%M"), tz=LOCAL_TZ)},
            {"role": "user", "content": text},
        ],
    }
    # A slow, restarting or misbehaving gateway is a gateway error for the client, not an unhandled 500.
    try:
        async with httpx.AsyncClient(timeout=HERMES_TIMEOUT) as client:
            r = await client.post(f"{HERMES_URL}/v1/chat/completions", json=body, headers=headers)
    except httpx.TimeoutException:
        log.warning("hermes timed out after %ss", HERMES_TIMEOUT)
        raise HTTPException(status_code=504, detail="hermes timeout") from None
    except httpx.HTTPError as e:
        log.warning("hermes unreachable: %r", e)
        raise HTTPException(status_code=502, detail="hermes unreachable") from None
    if r.status_code != 200:
        log.warning("hermes %s: %s", r.status_code, r.text[:300])
        raise HTTPException(status_code=502, detail=f"hermes error {r.status_code}")
    try:
        content = r.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        log.warning("hermes sent an unexpected body: %s", r.text[:300])
        raise HTTPException(status_code=502, detail="hermes bad response") from None
    if isinstance(content, list):  # content as parts: keep the text ones
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    reply = content if isinstance(content, str) else ""
    return reply.strip(), r.headers.get("X-Hermes-Session-Id") or session_id


_DISPLAY_RE = re.compile(r"<display>(.*?)</display>", re.S | re.I)
_ACTION_RE = re.compile(r"<action>(.*?)</action>", re.S | re.I)
_ALLOWED_ACTIONS = {"timer", "alarm", "cancel_timers", "volume", "theme"}
_THEME_MODES = {"day": "day", "light": "day", "night": "night", "dark": "night", "auto": "auto", "automatic": "auto"}

# ------------------------------------------------------------------ keep meeting links and passcodes off the screen
# The display sits in a room: a join link (which usually embeds the passcode), a meeting ID or a passcode must never
# reach it, whether it arrives in a calendar location, an event title, or the agent's own markdown.

_MEETING_HOSTS = (("zoom", "Zoom"), ("teams.microsoft", "Teams"), ("teams.live", "Teams"), ("meet.google", "Google Meet"),
                  ("webex", "Webex"), ("gotomeet", "GoTo"), ("goto.com", "GoTo"), ("whereby", "Whereby"))
_LINK_RE = re.compile(
    r"(?:https?://|www\.)\S+"                                                # anything with a scheme or www.
    r"|\b(?:[a-z0-9-]+\.)+(?:com|us|net|org|io|me|co|app|live|edu|gov)/\S*",  # host/path with no scheme
    re.I)
_MEETING_LINK_RE = re.compile(
    r"(?:https?://)?\b(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com"
    r"|webex\.com|gotomeet\.me|gotomeeting\.com|goto\.com|whereby\.com)\b\S*", re.I)
# "Passcode: abc123", "pwd=…", "passcode 493021", "PIN is 4410". Not "PIN reset training": without a separator the
# value must contain a digit.
_SECRET_RE = re.compile(
    r"\b(?:pass\s?code|password|pwd|pw|pin|access\s?code)\b(?:\s*[:#=]\s*|(?:\s+is)?\s+(?=[^\s)\]]*\d))[^\s)\]]+", re.I)
_MEETING_ID_RE = re.compile(r"\b(?:(?:meeting|conference|webinar)\s*)?id\b\s*[:#=]?\s*\d[\d\s-]{5,}\d", re.I)
_DIAL_RE = re.compile(r"(?:tel:)?\+?\d[\d\s().-]{6,}(?:[,;]+\s*[\d*#]+)+")   # phone number with ",,123456#" pauses
_DIGIT_RUN_RE = re.compile(r"\b\d(?:[\s-]?\d){8,}\b")                        # 9+ digits: a meeting ID or a dial-in


def _link_label(link: str) -> str:
    low = link.lower()
    return next((name for pat, name in _MEETING_HOSTS if pat in low), "Online")


def scrub(text: str, limit: int, links: str = "label") -> str:
    """Calendar text for the screen: links become the provider's name (or vanish), IDs and passcodes vanish."""
    text = _LINK_RE.sub((lambda m: _link_label(m.group())) if links == "label" else "", text or "")
    for pat in (_SECRET_RE, _MEETING_ID_RE, _DIAL_RE, _DIGIT_RUN_RE):
        text = pat.sub("", text)
    text = re.sub(r"\(\s*\)|\[\s*\]", "", text)                 # brackets emptied by the removals
    text = re.sub(r"\s+([,;:)\]])", r"\1", text)
    text = re.sub(r"\s{2,}", " ", text).strip(" \t,;:|/-–—")
    return text[:limit]


def scrub_display(md: str) -> str:
    """Agent markdown: only meeting join links are removed (other links are allowed when the user asks for them)."""
    return _MEETING_LINK_RE.sub(lambda m: _link_label(m.group()), md)


def _normalize_action(a: dict) -> dict | None:
    """Make an action exact for the client, or reject it. The Portal silently ignores anything it doesn't expect."""
    if a["type"] == "theme":
        mode = _THEME_MODES.get(str(a.get("mode") or a.get("theme") or "").strip().lower().removesuffix(" mode"))
        return {"type": "theme", "mode": mode} if mode else None
    return a


def split_reply(reply: str) -> tuple[str, str, list[dict]]:
    """Separate the spoken part, the screen markdown, and device actions."""
    display = scrub_display("\n\n".join(m.strip() for m in _DISPLAY_RE.findall(reply)))
    actions: list[dict] = []
    for raw in _ACTION_RE.findall(reply):
        try:
            a = json.loads(raw.strip())
        except json.JSONDecodeError:
            log.warning("bad action json: %r", raw[:200])
            continue
        if isinstance(a, dict) and isinstance(a.get("type"), str):
            a["type"] = a["type"].strip().lower()
        known = isinstance(a, dict) and isinstance(a.get("type"), str) and a["type"] in _ALLOWED_ACTIONS
        ok = _normalize_action(a) if known else None
        if ok is None:
            log.warning("dropped action: %r", raw[:200])
            continue
        actions.append(ok)
    speech = _ACTION_RE.sub("", _DISPLAY_RE.sub("", reply))
    speech = re.sub(r"</?(display|action)>", "", speech, flags=re.I).strip()
    return speech, display, actions


# ------------------------------------------------------------------ text to speech

_MD = [
    (re.compile(r"```.*?```", re.S), " "),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), " "),
    (re.compile(r"\[([^\]]+)\]\([^)]*\)"), r"\1"),
    (re.compile(r"https?://\S+"), " link "),
    (re.compile(r"^\s{0,3}#{1,6}\s*", re.M), ""),
    (re.compile(r"^\s*[-*+]\s+", re.M), ""),
    (re.compile(r"[*_~]{1,3}"), ""),
    (re.compile(r"\s+"), " "),
]


def speakable(text: str) -> str:
    for pat, rep in _MD:
        text = pat.sub(rep, text)
    text = text.strip()
    if len(text) > MAX_TTS_CHARS:
        cut = text[:MAX_TTS_CHARS]
        text = cut[: cut.rfind(".") + 1] or cut
    return text


async def synthesize(text: str) -> bytes:
    text = speakable(text)
    if not text:
        return b""
    chunks: list[bytes] = []
    async for chunk in edge_tts.Communicate(text, TTS_VOICE).stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


_SESSION_RE = re.compile(r"[\w.:-]{1,128}")


def clean_session(session_id: str | None) -> str | None:
    """A session id goes out as an HTTP header: anything that isn't a plain token starts a new conversation instead."""
    return session_id if session_id and _SESSION_RE.fullmatch(session_id) else None


async def respond(transcript: str, session_id: str | None, timings: dict) -> JSONResponse:
    if not transcript:
        return JSONResponse({"transcript": "", "reply": "", "speech": "", "display": "", "actions": [],
                             "session_id": session_id, "audio_b64": "", "timings": timings})
    t = time.monotonic()
    reply, session_id = await ask_hermes(transcript, session_id)
    timings["hermes"] = round(time.monotonic() - t, 2)
    speech, display, actions = split_reply(reply)
    t = time.monotonic()
    try:
        audio = await synthesize(speech)
    except Exception:  # TTS is best-effort; the text reply still goes back
        log.exception("tts failed")
        audio = b""
    timings["tts"] = round(time.monotonic() - t, 2)
    log.info("turn session=%s timings=%s display=%s actions=%s", session_id, timings, bool(display),
             [a.get("type") for a in actions])
    return JSONResponse(
        {
            "transcript": transcript,
            "reply": speech,  # back-compat for the web page: what was said
            "speech": speech,
            "display": display,
            "actions": actions,
            "session_id": session_id,
            "audio_b64": base64.b64encode(audio).decode() if audio else "",
            "timings": timings,
        }
    )


# ------------------------------------------------------------------ ambient: weather + agenda

_cache: dict[str, tuple[float, object]] = {}
_cal_lock = asyncio.Lock()


def _cached(key: str, ttl: float):
    hit = _cache.get(key)
    return hit[1] if hit and time.monotonic() - hit[0] < ttl else None


async def get_weather() -> dict | None:
    hit = _cached("weather", 600)
    if hit is not None:
        return hit  # type: ignore[return-value]
    params = {
        "latitude": WEATHER_LAT, "longitude": WEATHER_LON, "timezone": LOCAL_TZ,
        "temperature_unit": WEATHER_UNITS, "wind_speed_unit": "mph" if WEATHER_UNITS == "fahrenheit" else "kmh",
        "current": "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m",
        "hourly": "temperature_2m,weather_code,precipitation_probability,is_day",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
        "forecast_days": 5,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            d = (await c.get("https://api.open-meteo.com/v1/forecast", params=params)).raise_for_status().json()
    except Exception as e:  # noqa: BLE001
        log.warning("weather failed: %s", e)
        return (_cache.get("weather") or (0, None))[1]  # type: ignore[return-value]
    try:
        w = _parse_weather(d)
    except Exception as e:  # noqa: BLE001  (one odd payload must not take the whole idle screen down)
        log.warning("weather payload not usable: %r", e)
        return (_cache.get("weather") or (0, None))[1]  # type: ignore[return-value]
    _cache["weather"] = (time.monotonic(), w)
    return w


def _parse_weather(d: dict) -> dict:
    """Open-Meteo JSON to the idle screen's shape. Entries with a null temperature or code are skipped."""
    num = lambda v: isinstance(v, (int, float))  # noqa: E731
    cur, hourly, daily = d["current"], d["hourly"], d["daily"]
    now_iso = cur["time"][:13]
    start = next((i for i, t in enumerate(hourly["time"]) if t[:13] >= now_iso), 0)
    hours = [
        {"t": hourly["time"][i][11:16], "temp": round(hourly["temperature_2m"][i]),
         "code": hourly["weather_code"][i], "pop": hourly["precipitation_probability"][i] or 0,
         "day": hourly["is_day"][i] or 0}
        for i in range(start + 1, min(start + 9, len(hourly["time"])))
        if num(hourly["temperature_2m"][i]) and num(hourly["weather_code"][i])
    ]
    days = [
        {"date": daily["time"][i], "hi": round(daily["temperature_2m_max"][i]), "lo": round(daily["temperature_2m_min"][i]),
         "code": daily["weather_code"][i], "pop": daily["precipitation_probability_max"][i] or 0}
        for i in range(len(daily["time"]))
        if num(daily["temperature_2m_max"][i]) and num(daily["temperature_2m_min"][i]) and num(daily["weather_code"][i])
    ]
    today = next(x for x in days if x["date"] == daily["time"][0])  # no usable "today": StopIteration, caller falls back
    temp = round(cur["temperature_2m"])                             # no current temperature: TypeError, same
    feels, wind = cur.get("apparent_temperature"), cur.get("wind_speed_10m")
    return {
        "temp": temp, "feels": round(feels) if num(feels) else temp,
        "code": cur["weather_code"] if num(cur.get("weather_code")) else today["code"], "is_day": cur.get("is_day") or 0,
        "wind": round(wind) if num(wind) else 0,
        "humidity": cur.get("relative_humidity_2m"), "unit": "F" if WEATHER_UNITS == "fahrenheit" else "C",
        "hi": today["hi"], "lo": today["lo"], "pop": today["pop"],
        "sunrise": daily["sunrise"][0][11:16], "sunset": daily["sunset"][0][11:16],
        "hourly": hours, "daily": [x for x in days if x is not today][:4],
    }


async def _calendar_view() -> list[dict]:
    """Call the same read-only Microsoft 365 MCP server Hermes uses: no LLM, no Hermes session."""
    import yaml
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    with open(HERMES_CONFIG) as f:
        cfg = yaml.safe_load(f)["mcp_servers"][CALENDAR_MCP]
    env = {**os.environ, **{k: str(v) for k, v in (cfg.get("env") or {}).items()}}
    if NODE_BIN:
        env["PATH"] = f"{NODE_BIN}:{env.get('PATH', '')}"
    params = StdioServerParameters(command=cfg["command"], args=cfg["args"], env=env, cwd=cfg.get("cwd"))
    tz = ZoneInfo(LOCAL_TZ)
    start = dt.datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=2)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool("get-calendar-view", {
                "startDateTime": start.isoformat(), "endDateTime": end.isoformat(),
                "select": "subject,start,end,location,isAllDay,showAs,isCancelled,onlineMeeting",
                "orderby": "start/dateTime", "top": 40, "timezone": LOCAL_TZ,
            })
    data = json.loads(res.content[0].text)

    events = []
    for e in data.get("value", []):
        if e.get("isCancelled"):
            continue
        events.append({
            "title": scrub(e.get("subject") or "", 120, links="drop") or "(no title)",
            "start": e["start"]["dateTime"][:19], "end": e["end"]["dateTime"][:19],
            "allDay": bool(e.get("isAllDay")),
            "location": scrub((e.get("location") or {}).get("displayName") or "", 80),
            "online": bool(e.get("onlineMeeting")),
            "showAs": e.get("showAs") or "",
        })
    return events


async def get_agenda() -> tuple[list[dict] | None, str | None]:
    if not CALENDAR_ENABLED:
        return None, None
    hit = _cached("agenda", 300)
    if hit is not None:
        return hit, None  # type: ignore[return-value]
    async with _cal_lock:
        hit = _cached("agenda", 300)
        if hit is not None:
            return hit, None  # type: ignore[return-value]
        try:
            ev = await asyncio.wait_for(_calendar_view(), 60)
        except Exception as e:  # noqa: BLE001
            log.warning("calendar failed: %r", e)
            stale = _cache.get("agenda")
            return (stale[1] if stale else None), "calendar unavailable"  # type: ignore[return-value]
        _cache["agenda"] = (time.monotonic(), ev)
        return ev, None


# ------------------------------------------------------------------ routes

@app.get("/voice")
async def _slash() -> RedirectResponse:
    return RedirectResponse("/voice/")


@app.get("/voice/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/voice/health")
async def health() -> dict:
    return {"ok": True, "whisper_loaded": _whisper is not None}


@app.post("/voice/turn", dependencies=[Depends(require_key)])
async def turn(audio: UploadFile = File(...), session_id: str | None = Form(default=None)) -> JSONResponse:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty audio")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio too large")
    suffix = Path(audio.filename or "").suffix or ".webm"
    t = time.monotonic()
    try:
        transcript = await transcribe(data, suffix)
    except subprocess.CalledProcessError as e:
        log.warning("ffmpeg could not decode upload (%s, %d bytes): %s", suffix, len(data), (e.stderr or b"")[:300])
        raise HTTPException(status_code=422, detail="could not decode audio") from None
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=422, detail="audio decode timed out") from None
    timings = {"stt": round(time.monotonic() - t, 2)}
    return await respond(transcript, clean_session(session_id), timings)


class TextTurn(BaseModel):
    text: str
    session_id: str | None = None


@app.post("/voice/text", dependencies=[Depends(require_key)])
async def text_turn(body: TextTurn) -> JSONResponse:
    return await respond(body.text.strip(), clean_session(body.session_id), {})


@app.get("/voice/ambient", dependencies=[Depends(require_key)])
async def ambient() -> JSONResponse:
    weather, (agenda, agenda_error) = await asyncio.gather(get_weather(), get_agenda())
    return JSONResponse({
        "place": PLACE_NAME, "tz": LOCAL_TZ,
        "generated": dt.datetime.now(ZoneInfo(LOCAL_TZ)).isoformat(timespec="seconds"),
        "weather": weather, "agenda": agenda, "agenda_error": agenda_error,
    })


if __name__ == "__main__":
    import uvicorn

    host, port = os.environ.get("BIND_HOST", "0.0.0.0"), int(os.environ.get("BIND_PORT", "8650"))
    proxied = host in ("127.0.0.1", "localhost", "::1")  # behind a reverse proxy on this machine
    uvicorn.run(app, host=host, port=port, proxy_headers=proxied, forwarded_allow_ips="127.0.0.1" if proxied else None)
