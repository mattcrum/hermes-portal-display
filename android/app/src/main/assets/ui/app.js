/* Hermes Display — UI logic.
 *
 * Native (Kotlin) owns the mic, wake word, network, audio, and timers. It drives this page through
 * window.HV.* and receives intents through window.Native.*. Without window.Native (a desktop browser)
 * the page runs a mock so the design can be worked on at 1280x800.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var TAU = Math.PI * 2;
  var Native = window.Native || null;

  var S = {
    state: "loading", mode: "ambient", theme: "auto", clock: "12", cal: "on",
    ambient: null, timers: [], ringing: null, sleeping: false,
    level: 0, levelTarget: 0, levelAt: 0,
    lastActivity: Date.now(), lastTurnAt: 0, thinkStart: 0, settings: {}
  };

  // ------------------------------------------------------------------ helpers
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function parseLocal(s) { return new Date(s.length === 10 ? s + "T00:00:00" : s); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function hm(d, compact) {
    if (S.clock === "24") return pad(d.getHours()) + ":" + pad(d.getMinutes());
    var h = d.getHours() % 12 || 12, m = d.getMinutes();
    if (compact) return h + (m ? ":" + pad(m) : "") + (d.getHours() < 12 ? "a" : "p");
    return h + ":" + pad(m);
  }
  function ampm(d) { return S.clock === "24" ? "" : (d.getHours() < 12 ? "AM" : "PM"); }
  function hourLabel(hhmm) {
    var h = +hhmm.slice(0, 2);
    if (S.clock === "24") return hhmm.slice(0, 2);
    return (h % 12 || 12) + (h < 12 ? "A" : "P");
  }
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function toast(msg, ms) {
    var t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add("hidden"); }, ms || 3200);
  }
  function mountWing(el) { el.innerHTML = window.WING_SVG || ""; }
  function activity() { S.lastActivity = Date.now(); if (S.sleeping) setSleeping(false); }

  // ------------------------------------------------------------------ weather glyphs (WMO codes)
  var WX = {
    sun: '<circle cx="16" cy="16" r="6"/><path d="M16 3v4M16 25v4M3 16h4M25 16h4M6.8 6.8l2.8 2.8M22.4 22.4l2.8 2.8M6.8 25.2l2.8-2.8M22.4 9.6l2.8-2.8"/>',
    moon: '<path d="M21.5 20.5A9 9 0 0 1 11.5 6.2a10 10 0 1 0 14.3 11.4 9 9 0 0 1-4.3 2.9z"/>',
    cloud: '<path d="M9 25h14a5.5 5.5 0 0 0 .6-11A8 8 0 0 0 8.2 15.6 4.8 4.8 0 0 0 9 25z"/>',
    partSun: '<path d="M12 4v2.5M4.6 7.6l1.8 1.8M2 15h2.5M19.4 7.6l-1.8 1.8"/><path d="M8.3 13.6A5 5 0 0 1 16.6 10"/><path d="M11 27h12a4.8 4.8 0 0 0 .5-9.6A7 7 0 0 0 10 18.8 4.2 4.2 0 0 0 11 27z"/>',
    partMoon: '<path d="M13.5 12.6A5.6 5.6 0 0 1 7.3 3.9a6.3 6.3 0 1 0 8.8 7.2"/><path d="M11 27h12a4.8 4.8 0 0 0 .5-9.6A7 7 0 0 0 10 18.8 4.2 4.2 0 0 0 11 27z"/>',
    rain: '<path d="M9 20h14a5.5 5.5 0 0 0 .6-11A8 8 0 0 0 8.2 10.6 4.8 4.8 0 0 0 9 20z"/><path d="M11 24l-1.5 4M16 24l-1.5 4M21 24l-1.5 4"/>',
    snow: '<path d="M9 20h14a5.5 5.5 0 0 0 .6-11A8 8 0 0 0 8.2 10.6 4.8 4.8 0 0 0 9 20z"/><path d="M11 24.5h.01M16 26.5h.01M21 24.5h.01M13.5 29h.01M18.5 29h.01" stroke-width="2.6" stroke-linecap="round"/>',
    storm: '<path d="M9 20h14a5.5 5.5 0 0 0 .6-11A8 8 0 0 0 8.2 10.6 4.8 4.8 0 0 0 9 20z"/><path d="M17 21l-3.5 5h5l-3 5"/>',
    fog: '<path d="M5 12h22M3 17h26M7 22h18M10 27h12"/>'
  };
  function wxKind(code, isDay) {
    if (code === 0) return isDay ? "sun" : "moon";
    if (code <= 2) return isDay ? "partSun" : "partMoon";
    if (code === 3) return "cloud";
    if (code === 45 || code === 48) return "fog";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
    if (code >= 95) return "storm";
    return "rain";
  }
  function wxDesc(code) {
    if (code === 0) return "Clear";
    if (code === 1) return "Mostly clear";
    if (code === 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if (code >= 51 && code <= 57) return "Drizzle";
    if (code >= 61 && code <= 67) return code >= 65 ? "Heavy rain" : "Rain";
    if (code >= 71 && code <= 77) return "Snow";
    if (code >= 80 && code <= 82) return "Showers";
    if (code === 85 || code === 86) return "Snow showers";
    if (code >= 95) return "Thunderstorms";
    return "—";
  }
  function wxSvg(code, isDay) {
    return '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">' + WX[wxKind(code, isDay)] + "</svg>";
  }

  // ------------------------------------------------------------------ theme + sleep
  function sunTimes() {
    var w = S.ambient && S.ambient.weather, now = new Date();
    function at(hhmm, fallbackH, fallbackM) {
      var d = new Date(now);
      if (hhmm) { d.setHours(+hhmm.slice(0, 2), +hhmm.slice(3, 5), 0, 0); } else { d.setHours(fallbackH, fallbackM, 0, 0); }
      return d;
    }
    return { rise: at(w && w.sunrise, 6, 30), set: at(w && w.sunset, 17, 30) };
  }
  function applyTheme() {
    var t = S.theme;
    if (t === "auto") {
      var now = new Date(), st = sunTimes();
      t = (now >= st.rise && now < new Date(st.set.getTime() + 30 * 60000)) ? "day" : "night";
    }
    if (body.getAttribute("data-theme") !== t) { body.setAttribute("data-theme", t); readRayColors(); }
  }
  function setSleeping(on) {
    if (S.sleeping === on) return;
    S.sleeping = on;
    $("sleep").classList.toggle("hidden", !on);
  }
  function checkSleep() {
    var h = new Date().getHours();
    var night = h >= 23 || h < 6;
    var idle = Date.now() - S.lastActivity > 90000;
    setSleeping(S.forceSleep || (night && idle && S.state === "wake" && !S.ringing));
  }
  $("sleep").addEventListener("click", activity);

  // ------------------------------------------------------------------ clock
  var colon = document.querySelector(".clock .colon");
  function tick() {
    var d = new Date();
    var h = S.clock === "24" ? pad(d.getHours()) : String(d.getHours() % 12 || 12);
    $("hh").textContent = h; $("mm").textContent = pad(d.getMinutes());
    $("ampm").textContent = ampm(d);
    $("date").textContent = DAYS[d.getDay()] + " · " + d.getDate() + " " + MONTHS[d.getMonth()];
    $("sleepClock").textContent = h + ":" + pad(d.getMinutes());
    colon.classList.toggle("dim", d.getSeconds() % 2 === 1);
    $("nextUp").classList.toggle("pulse", d.getSeconds() % 2 === 1);
    if (d.getSeconds() === 0) { renderAgenda(); applyTheme(); }
    renderTimers();
    checkSleep();
    if (S.state === "thinking") $("elapsed").textContent = Math.round((Date.now() - S.thinkStart) / 1000) + "s";
    // drift back to the ambient screen after a quiet conversation
    if (S.mode === "convo" && S.state === "wake" && Date.now() - S.lastTurnAt > 45000 && Date.now() - S.lastActivity > 45000) setMode("ambient");
  }

  // ------------------------------------------------------------------ ambient render
  function renderWeather() {
    var w = S.ambient && S.ambient.weather;
    if (!w) return;
    $("wxIcon").innerHTML = wxSvg(w.code, w.is_day);
    $("wxTemp").textContent = w.temp;
    $("wxDesc").textContent = wxDesc(w.code);
    $("wxMeta").textContent = "H " + w.hi + "°  L " + w.lo + "°  ·  Feels " + w.feels + "°  ·  Wind " + w.wind + (w.unit === "F" ? " mph" : " km/h") + (w.pop >= 20 ? "  ·  Rain " + w.pop + "%" : "");
    $("hourly").innerHTML = (w.hourly || []).map(function (h) {
      return '<li><span class="h">' + hourLabel(h.t) + '</span><span class="i">' + wxSvg(h.code, h.day) + '</span><span class="t">' + h.temp + '°</span><span class="p">' + (h.pop >= 20 ? h.pop + "%" : "") + "</span></li>";
    }).join("");
    $("daily").innerHTML = (w.daily || []).map(function (d) {
      var day = parseLocal(d.date);
      return '<li><span class="d">' + DAYS[day.getDay()].slice(0, 3) + '</span><span class="i">' + wxSvg(d.code, 1) + '</span><span class="r">' + d.hi + "° <em>" + d.lo + "°</em></span></li>";
    }).join("");
  }

  function relTime(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return "now";
    if (m < 60) return "in " + m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    return "in " + h + " h" + (r ? " " + r + " min" : "");
  }

  function renderAgenda() {
    var col = document.querySelector(".col-right");
    var show = S.cal === "on";
    col.classList.toggle("hidden", !show);
    document.getElementById("ambient").style.gridTemplateColumns = show ? "" : "1fr";
    if (!show || !S.ambient) return;
    var ev = S.ambient.agenda;
    var now = new Date(), tomorrow = new Date(now.getTime() + 86400000);
    if (!ev) {
      $("agendaToday").innerHTML = '<li class="empty">' + (S.ambient.agenda_error ? "Calendar unavailable" : "No calendar") + "</li>";
      $("agendaTomorrow").innerHTML = ""; $("nextUp").classList.add("hidden"); return;
    }
    var today = [], tmr = [];
    ev.forEach(function (e) {
      var s = parseLocal(e.start), en = parseLocal(e.end);
      var item = { e: e, s: s, en: en };
      if (sameDay(s, now) || (e.allDay && s <= now && en > now)) today.push(item); else if (sameDay(s, tomorrow)) tmr.push(item);
    });
    function li(x) {
      var cls = x.en <= now ? "past" : (x.s <= now ? "current" : "");
      var where = x.e.location || (x.e.online ? "Online" : "");
      return '<li class="' + cls + '"><span class="et">' + (x.e.allDay ? "ALL DAY" : hm(x.s)) + '</span><div><div class="en">' + esc(x.e.title) + "</div>" + (where ? '<div class="el">' + esc(where) + "</div>" : "") + "</div></li>";
    }
    $("agendaToday").innerHTML = today.length ? today.map(li).join("") : '<li class="empty">Nothing else today</li>';
    $("agendaTomorrow").innerHTML = tmr.length ? tmr.map(li).join("") : '<li class="empty">Nothing scheduled</li>';
    var left = today.filter(function (x) { return x.en > now; }).length;
    $("todayCount").textContent = today.length ? (left ? left + " left" : "all done") : "";
    $("tomorrowCount").textContent = tmr.length ? String(tmr.length) : "";

    var next = today.concat(tmr).filter(function (x) { return !x.e.allDay && x.en > now; })[0];
    var box = $("nextUp");
    if (!next) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    var on = next.s <= now;
    box.classList.toggle("now-on", on);
    $("nextWhen").textContent = on ? "Happening now · ends " + hm(next.en) + " " + ampm(next.en)
      : (sameDay(next.s, now) ? "Next · " + relTime(next.s - now) : "Tomorrow · " + hm(next.s) + " " + ampm(next.s));
    $("nextTitle").textContent = next.e.title;
    $("nextMeta").textContent = hm(next.s) + "–" + hm(next.en) + " " + ampm(next.en) + (next.e.location ? "  ·  " + next.e.location : (next.e.online ? "  ·  Online" : ""));
    $("sleepNext").textContent = sameDay(next.s, now) ? "" : "Tomorrow " + hm(next.s) + " " + ampm(next.s) + " · " + next.e.title;
  }

  function renderChips() {
    var h = new Date().getHours();
    var list = h < 11 ? ["Brief me on today", "What's the weather?", "Set a 10-minute timer"]
      : h < 17 ? ["What's next on my calendar?", "Any important email?", "Set a 25-minute focus timer"]
      : ["What's on tomorrow?", "Weather this weekend", "Set an alarm for 7 AM"];
    $("chips").innerHTML = list.map(function (t) { return '<button class="chip">' + esc(t) + "</button>"; }).join("");
  }
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest(".chip"); if (!b) return;
    activity(); ask(b.textContent);
  });

  // ------------------------------------------------------------------ timers
  function fmtDur(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(r);
  }
  function renderTimers() {
    var now = Date.now();
    $("timerChips").innerHTML = S.timers.slice(0, 3).map(function (t) {
      var left = t.endsAt - now, pct = t.total ? Math.max(0, Math.min(1, 1 - left / t.total)) : 0;
      var val = t.kind === "alarm" ? hm(new Date(t.endsAt)) + " " + ampm(new Date(t.endsAt)) : fmtDur(left);
      return '<div class="tchip"><span class="tl">' + esc(t.label || (t.kind === "alarm" ? "Alarm" : "Timer")) + '</span><span class="tt">' + val +
        '</span><button class="tx" data-id="' + t.id + '" aria-label="Cancel">✕</button><i class="tp" style="width:' + (pct * 100).toFixed(1) + '%"></i></div>';
    }).join("");
  }
  $("timerChips").addEventListener("click", function (e) {
    var b = e.target.closest(".tx"); if (!b) return;
    activity(); if (Native) Native.cancelTimer(b.getAttribute("data-id")); else { S.timers = S.timers.filter(function (t) { return t.id !== b.getAttribute("data-id"); }); renderTimers(); }
  });
  $("ring").addEventListener("click", function () { activity(); if (Native) Native.stopAll(); else HV.ringing(null); });

  // ------------------------------------------------------------------ markdown (small, escaped)
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  }
  function md(src) {
    var lines = String(src || "").replace(/\r/g, "").split("\n"), out = [], i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (!l.trim()) { i++; continue; }
      var h = /^(#{1,3})\s+(.*)$/.exec(l);
      if (h) { out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*\|/.test(l)) {
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        var cells = function (r) { return r.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
        var hasSep = rows.length > 1 && /^[\s|:\-]+$/.test(rows[1]);
        var head = hasSep ? cells(rows[0]) : null, bodyRows = rows.slice(hasSep ? 2 : 0).map(cells);
        out.push("<table>" + (head ? "<tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr>" : "") +
          bodyRows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</table>");
        continue;
      }
      var ul = /^\s*[-*+]\s+/, ol = /^\s*\d+[.)]\s+/;
      if (ul.test(l) || ol.test(l)) {
        var isOl = ol.test(l), re = isOl ? ol : ul, items = [];
        while (i < lines.length && re.test(lines[i])) { items.push("<li>" + inline(lines[i].replace(re, "")) + "</li>"); i++; }
        out.push((isOl ? "<ol>" : "<ul>") + items.join("") + (isOl ? "</ol>" : "</ul>"));
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*\||\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i])) { para.push(lines[i]); i++; }
      out.push("<p>" + inline(para.join(" ")) + "</p>");
    }
    return out.join("");
  }

  // ------------------------------------------------------------------ mode + state
  var STATUS = { loading: "Starting", wake: "Say “Hey Hermes”", listening: "Listening", thinking: "Thinking", speaking: "Speaking", error: "Offline" };
  function setMode(m) { if (S.mode === m) return; S.mode = m; body.setAttribute("data-mode", m); }
  function setState(st, info) {
    S.state = st; body.setAttribute("data-state", st);
    $("status").textContent = (st === "error" && info) ? info : (STATUS[st] || st);
    if (st !== "wake") activity();
    if (st === "listening") {
      setMode("convo");
      $("you").textContent = ""; $("speech").className = "speech"; $("speech").textContent = "";
      $("card").classList.add("hidden"); $("meta").textContent = ""; $("elapsed").textContent = "";
    } else if (st === "thinking") {
      setMode("convo");
      S.thinkStart = Date.now();
      $("speech").className = "speech thinking"; $("speech").innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      $("card").classList.add("hidden");
    } else if (st === "speaking") {
      setMode("convo");
    } else if (st === "error" && info) {
      toast(info);
    }
    $("net").className = "net " + (st === "error" ? "bad" : "ok");
  }

  function ask(text) {
    setMode("convo");
    $("you").textContent = text;
    if (Native) Native.ask(text); else mockTurn(text);
  }

  // ------------------------------------------------------------------ the burst (orb + ambient rays)
  var cv = $("burst"), cx = cv.getContext("2d"), mini = $("miniOrb"), mx = mini.getContext("2d");
  var W = 0, H = 0, ray = "242,242,242", rayHot = "255,201,60", convoT = 0, sweep = 0, lastFrame = 0;
  function readRayColors() {
    var cs = getComputedStyle(body);
    ray = cs.getPropertyValue("--ray").trim() || ray;
    rayHot = cs.getPropertyValue("--ray-hot").trim() || rayHot;
    if (window.HArt) HArt.setColors({ dither: cs.getPropertyValue("--dither").trim(), da: cs.getPropertyValue("--dither-a").trim(), ray: ray, hot: rayHot, seal: cs.getPropertyValue("--seal").trim(), sealHot: cs.getPropertyValue("--seal-hot").trim(), line: cs.getPropertyValue("--bg").trim() });
  }
  function resize() { W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; if (window.HArt) HArt.initDither($("dither"), W, H); }
  window.addEventListener("resize", resize);
  // Per-ray phase/frequency so the burst reads like an engraving, not a gear.
  var PH = [], FQ = [];
  for (var q = 0; q < 400; q++) { PH.push(Math.random() * TAU); FQ.push(0.6 + Math.random() * 2.2); }
  function noise(i, t) {
    return 0.5 + 0.28 * Math.sin(i * 0.37 + t * 2.1) + 0.22 * Math.sin(i * 0.113 - t * 1.37 + Math.sin(i * 0.05 + t * 0.6) * 2);
  }
  function rayLen(i, a, t, jitterAmt) {
    var env = 0.55 + 0.22 * Math.sin(3 * a + t * 0.9) + 0.16 * Math.sin(5 * a - t * 1.3 + 1.7) + 0.07 * Math.sin(11 * a + t * 2.3);
    var jit = 1 - jitterAmt + jitterAmt * (0.5 + 0.5 * Math.sin(t * FQ[i] * 2.4 + PH[i]));
    return env * jit;
  }
  function angDist(a, b) { var d = Math.abs(((a - b) % TAU + TAU) % TAU); return Math.min(d, TAU - d); }

  function drawOrb(ctx, x, y, r0, maxLen, n, t, alpha, lw) {
    var st = S.state, lvl = S.level;
    var amp, base, hot = st === "listening";
    if (st === "listening") { base = 6; amp = 18 + lvl * maxLen; }
    else if (st === "speaking") { base = 10; amp = maxLen * 0.18 + lvl * maxLen * 0.95; }
    else if (st === "thinking") { base = 10; amp = maxLen * 0.22; }
    else { base = 6; amp = maxLen * (0.16 + 0.05 * Math.sin(t * 0.9)); }
    var rot = t * (st === "thinking" ? 0.35 : 0.06);
    ctx.lineWidth = lw; ctx.lineCap = "butt";
    var jitter = st === "listening" || st === "speaking" ? 0.35 + 0.5 * lvl : 0.3;
    var NBK = 6, bucket = [];
    for (var b0 = 0; b0 < NBK; b0++) bucket.push([]);
    for (var i = 0; i < n; i++) {
      var a = i / n * TAU + rot;
      var al = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * FQ[(i + 7) % 400] + PH[(i + 13) % 400]));
      if (st === "thinking") al = 0.14 + 0.86 * Math.exp(-Math.pow(angDist(a, sweep), 2) / 0.35);
      bucket[Math.min(NBK - 1, (al * NBK) | 0)].push(i);
    }
    for (var bb = 0; bb < NBK; bb++) {
      if (!bucket[bb].length) continue;
      ctx.strokeStyle = "rgba(" + (hot ? rayHot : ray) + "," + (alpha * (bb + 0.5) / NBK).toFixed(3) + ")";
      ctx.beginPath();
      for (var j = 0; j < bucket[bb].length; j++) {
        var ii = bucket[bb][j], aa = ii / n * TAU + rot;
        var len = base + amp * rayLen(ii % 400, aa, t, jitter), ca = Math.cos(aa), sa = Math.sin(aa);
        ctx.moveTo(x + ca * r0, y + sa * r0); ctx.lineTo(x + ca * (r0 + len), y + sa * (r0 + len));
      }
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(" + ray + "," + (alpha * 0.55).toFixed(3) + ")";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, r0 - 10, 0, TAU); ctx.stroke();
  }


  // ------------------------------------------------------------------ the sky (background)
  // A celestial engraving: the ray-burst is a sun just past the bottom-right corner, ringed by an
  // astrolabe whose graduations turn slowly (faster while Hermes thinks). Mercury — Hermes' planet —
  // rises and sets along one orbit. Motes drift off the sun, a caduceus double-helix flows along the
  // dock, stars twinkle at night, and a messenger comet crosses now and then (and on every reply).
  var ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII", "XXIII", "XXIV"];
  var ringPhase = 0, ringSpeed = 1, nightAmt = 0, comet = null, nextComet = 0;
  var STARS = [], MOTES = [], SPARKS = [];
  function newSpark(p, t, fresh) {
    // spawn only in open sky: not on the clock, the weather block or the agenda column
    do { p.x = 0.03 + Math.random() * 0.94; p.y = 0.1 + Math.random() * 0.76; }
    while ((p.x < 0.4 && p.y < 0.42) || (p.x > 0.6 && p.y < 0.86) || (p.x < 0.58 && p.y > 0.5 && p.y < 0.86));
    p.r = 5 + Math.pow(Math.random(), 2) * 16;
    p.t0 = t + (fresh ? Math.random() * 6 : 1 + Math.random() * 7); p.life = 2.5 + Math.random() * 4; p.a = 0.35 + Math.random() * 0.45; p.hot = Math.random() < 0.35;
    return p;
  }
  for (var si = 0; si < 130; si++) STARS.push({ x: Math.random(), y: Math.random() * 0.86, r: 0.5 + Math.pow(Math.random(), 3) * 1.4, ph: Math.random() * TAU, f: 0.3 + Math.random() * 1.2 });
  function newMote(m, fresh) {
    m.a = Math.PI + 0.04 + Math.random() * (Math.PI / 2 - 0.08);
    m.r = fresh ? 280 + Math.random() * 1100 : 270 + Math.random() * 60;
    m.v = 9 + Math.random() * 20; m.s = 0.6 + Math.random() * 1.3;
    m.life = 0; m.max = 9 + Math.random() * 16; m.ph = Math.random() * TAU; m.w = (Math.random() - 0.5) * 0.004;
    return m;
  }
  for (var mi = 0; mi < 44; mi++) { var mo = newMote({}, true); mo.life = Math.random() * mo.max; MOTES.push(mo); }
  function launchComet(t) {
    comet = { t0: t, dur: 2.6 + Math.random() * 0.8, a: Math.PI + 0.25 + Math.random() * (Math.PI / 2 - 0.5), bend: (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.1) };
  }
  function cometPos(c, u, ox, oy) {
    var r = 300 + u * 1650, a = c.a + c.bend * u * u;
    return [ox + Math.cos(a) * r, oy + Math.sin(a) * r];
  }

  function drawSky(t, dt, amb) {
    var ox = W * 1.02, oy = H * 1.18, ctx = cx;
    var want = body.getAttribute("data-theme") === "night" ? 1 : 0;
    nightAmt += (want - nightAmt) * Math.min(1, dt * 1.5);
    var target = S.state === "thinking" ? 9 : (S.state === "listening" || S.state === "speaking") ? 2.2 : 1;
    ringSpeed += (target - ringSpeed) * Math.min(1, dt * 2);
    ringPhase += dt * ringSpeed;
    var sky = 0.45 + 0.55 * amb; // the sky stays, dimmed, behind the conversation

    // stars (night)
    if (nightAmt > 0.02) {
      ctx.fillStyle = "rgb(255,236,190)";
      for (var i = 0; i < STARS.length; i++) {
        var s = STARS[i];
        ctx.globalAlpha = nightAmt * sky * (0.12 + 0.5 * (0.5 + 0.5 * Math.sin(t * s.f + s.ph)));
        ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
      }
      ctx.globalAlpha = 1;
    }

    // four-point sparkles (the Nous ✦): a few bloom and fade around the sky
    if (!SPARKS.length) for (var sp = 0; sp < 7; sp++) SPARKS.push(newSpark({}, t, true));
    for (var sk = 0; sk < SPARKS.length; sk++) {
      var P = SPARKS[sk], pu = (t - P.t0) / P.life;
      if (pu >= 1) { newSpark(P, t, false); continue; }
      if (pu < 0) continue;
      var pe = Math.sin(Math.PI * pu); pe = pe * pe;
      HArt.sparkle(ctx, P.x * W, P.y * H, P.r * (0.4 + 0.6 * pe), sky * pe * P.a, P.hot ? rayHot : ray);
    }

    // astrolabe rings around the sun
    var A0 = Math.PI - 0.12, A1 = Math.PI * 1.5 + 0.12;
    function ring(r, alpha, dash) {
      ctx.strokeStyle = "rgba(" + ray + "," + (alpha * sky).toFixed(3) + ")";
      ctx.setLineDash(dash || []); ctx.beginPath(); ctx.arc(ox, oy, r, A0, A1); ctx.stroke(); ctx.setLineDash([]);
    }
    function ticks(r, step, len, majorEvery, majorLen, alpha, rot) {
      ctx.strokeStyle = "rgba(" + ray + "," + (alpha * sky).toFixed(3) + ")";
      ctx.beginPath();
      var k0 = Math.ceil((A0 - rot) / step), k1 = Math.floor((A1 - rot) / step);
      for (var k = k0; k <= k1; k++) {
        var a = k * step + rot, l = (majorEvery && k % majorEvery === 0) ? majorLen : len;
        var c = Math.cos(a), sn = Math.sin(a);
        ctx.moveTo(ox + c * r, oy + sn * r); ctx.lineTo(ox + c * (r - l), oy + sn * (r - l));
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    var D = Math.PI / 180;
    ring(300, 0.16); ticks(300, 5 * D, 7, 6, 16, 0.2, ringPhase * 0.012);
    ring(430, 0.1, [2, 7]);
    ring(600, 0.12); ticks(600, 2 * D, 5, 5, 12, 0.13, -ringPhase * 0.006);
    var mercR = 820; ring(mercR, 0.11);
    ring(1080, 0.08, [1, 11]); ticks(1080, 15 * D, 10, 1, 10, 0.16, ringPhase * 0.003);
    ring(1400, 0.06);
    // numerals on the outer graduated ring
    ctx.fillStyle = "rgba(" + ray + "," + (0.22 * sky).toFixed(3) + ")";
    ctx.font = "500 11px 'JetBrains Mono', monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var nrot = ringPhase * 0.003;
    for (var n = Math.ceil((A0 - nrot) / (15 * D)); n <= Math.floor((A1 - nrot) / (15 * D)); n++) {
      var na = n * 15 * D + nrot, lr = 1080 - 24;
      ctx.save(); ctx.translate(ox + Math.cos(na) * lr, oy + Math.sin(na) * lr); ctx.rotate(na + Math.PI / 2);
      ctx.fillText(ROMAN[((n % 24) + 24) % 24], 0, 0); ctx.restore();
    }

    // the sun's rays (kept from v0.2, breathing a touch more)
    var nr = 180, rrot = t * 0.004;
    // batched into a few alpha buckets: one stroke per bucket instead of one per ray
    var top = (0.03 + 0.06 * amb) * 1.5, NB = 6;
    for (var bk = 0; bk < NB; bk++) {
      ctx.strokeStyle = "rgba(" + ray + "," + (top * (bk + 0.5) / NB).toFixed(3) + ")";
      ctx.beginPath();
      for (var i2 = 0; i2 < nr; i2++) {
        var al2 = (0.5 + noise(i2 + 20, t * 0.12)) / 1.5;
        if (Math.min(NB - 1, (al2 * NB) | 0) !== bk) continue;
        var a2 = Math.PI + (i2 / nr) * (Math.PI / 2) + Math.sin(rrot + i2) * 0.002 - 0.05 + rrot;
        var len2 = 900 + 480 * noise(i2, t * 0.08);
        ctx.moveTo(ox + Math.cos(a2) * 260, oy + Math.sin(a2) * 260); ctx.lineTo(ox + Math.cos(a2) * len2, oy + Math.sin(a2) * len2);
      }
      ctx.stroke();
    }

    // Mercury: rises over the horizon of its orbit, crosses the sky, sets (~2.5 min a pass)
    var per = 150, u = (t / per) % 1, ma = A0 + 0.05 + u * (A1 - A0 - 0.1);
    var mpx = ox + Math.cos(ma) * mercR, mpy = oy + Math.sin(ma) * mercR;
    var fade = Math.min(1, Math.min(u, 1 - u) * 12);
    ctx.strokeStyle = "rgba(" + rayHot + "," + (0.35 * fade * sky).toFixed(3) + ")"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, mercR, ma - 0.09, ma); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(" + rayHot + "," + (0.12 * fade * sky).toFixed(3) + ")";
    ctx.beginPath(); ctx.arc(mpx, mpy, 11, 0, TAU); ctx.fill();
    ctx.fillStyle = "rgba(" + rayHot + "," + (0.85 * fade * sky).toFixed(3) + ")";
    ctx.beginPath(); ctx.arc(mpx, mpy, 3.2, 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(" + rayHot + "," + (0.4 * fade * sky).toFixed(3) + ")";
    ctx.beginPath(); ctx.arc(mpx, mpy, 7 + 2 * Math.sin(t * 1.4), 0, TAU); ctx.stroke();

    // motes drifting off the sun
    ctx.fillStyle = "rgb(" + rayHot + ")";
    var drift = S.state === "listening" || S.state === "speaking" ? 1 + 2.5 * S.level : 1;
    for (var j = 0; j < MOTES.length; j++) {
      var m = MOTES[j];
      m.life += dt; m.r += m.v * dt * drift; m.a += m.w * dt;
      if (m.life > m.max || m.r > 1700) { newMote(m, false); continue; }
      var lf = Math.sin(Math.PI * m.life / m.max);
      ctx.globalAlpha = sky * lf * (0.25 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2 + m.ph)));
      var px = ox + Math.cos(m.a) * m.r, py = oy + Math.sin(m.a) * m.r;
      if (px < 0 || py < 0) continue;
      ctx.fillRect(px, py, m.s, m.s);
    }
    ctx.globalAlpha = 1;

    // caduceus: two serpents braided along the dock line
    var yb = H - 104, amp = 7, wl = 260, flow = t * 18;
    var hel = 0.14 + 0.08 * (S.state === "listening" ? 1 : 0);
    for (var strand = 0; strand < 2; strand++) {
      ctx.strokeStyle = "rgba(" + (strand ? rayHot : ray) + "," + (hel * (strand ? 1.1 : 1)).toFixed(3) + ")";
      ctx.beginPath();
      for (var x = 0; x <= W; x += 8) {
        var y = yb + (strand ? -1 : 1) * amp * Math.sin((x + flow) / wl * TAU) * (0.6 + 0.4 * Math.sin(x / W * Math.PI));
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(" + rayHot + "," + (hel * 2.4).toFixed(3) + ")";
    var off = ((-flow) % (wl / 2) + wl / 2) % (wl / 2);
    for (var cxp = off; cxp <= W; cxp += wl / 2) { ctx.beginPath(); ctx.arc(cxp, yb, 1.6, 0, TAU); ctx.fill(); }

    // messenger comet
    if (!nextComet) nextComet = t + 12 + Math.random() * 20;
    if (!comet && t > nextComet && amb > 0.5) launchComet(t);
    if (comet) {
      var cu = (t - comet.t0) / comet.dur;
      if (cu >= 1) { comet = null; nextComet = t + 35 + Math.random() * 50; }
      else {
        var e = cu < 0.5 ? 2 * cu * cu : 1 - Math.pow(-2 * cu + 2, 2) / 2;
        var head = cometPos(comet, e, ox, oy), tail = cometPos(comet, Math.max(0, e - 0.16), ox, oy);
        var ca = Math.sin(Math.PI * cu);
        var g = ctx.createLinearGradient(tail[0], tail[1], head[0], head[1]);
        g.addColorStop(0, "rgba(" + rayHot + ",0)"); g.addColorStop(1, "rgba(" + rayHot + "," + (0.75 * ca).toFixed(3) + ")");
        ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(tail[0], tail[1]); ctx.lineTo(head[0], head[1]); ctx.stroke();
        ctx.lineCap = "butt"; ctx.lineWidth = 1;
        ctx.fillStyle = "rgba(255,248,220," + (0.9 * ca).toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(head[0], head[1], 2, 0, TAU); ctx.fill();
      }
    }
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (S.sleeping) return;
    var fps = S.mode === "convo" || S.state !== "wake" || comet ? 30 : 15;
    if (ts - lastFrame < 1000 / fps - 2) return;
    var dt = Math.min(0.1, (ts - lastFrame) / 1000); lastFrame = ts;
    var t = ts / 1000;
    if (Date.now() - S.levelAt > 250) S.levelTarget *= 0.85;
    S.level += (S.levelTarget - S.level) * 0.3;
    sweep = (sweep + dt * 2.4) % TAU;
    convoT += ((S.mode === "convo" ? 1 : 0) - convoT) * Math.min(1, dt * 5);

    cx.clearRect(0, 0, W, H);
    HArt.dither(t, { amb: 1 - convoT, state: S.state, level: S.level });
    drawSky(t, dt, 1 - convoT);
    // conversation: the orb
    if (convoT > 0.01) {
      var orbX = 32 + 280, orbY = 68 + 18 + (H - 68 - 104 - 18) / 2;
      var sealR = 168;
      drawOrb(cx, orbX, orbY, sealR + 16 + 14 * (1 - convoT), 108, 168, t, convoT, 1.5);
      HArt.character(cx, orbX, orbY, sealR, t, { state: S.state, level: S.level, alpha: convoT, appear: convoT });
    }
    // dock mini orb
    mx.clearRect(0, 0, 72, 72);
    drawOrb(mx, 36, 36, 16, 18, 44, t, 1, 1.4);
    HArt.coin(mx, 36, 36, 13);
  }

  // ------------------------------------------------------------------ settings sheet
  function segSet(id, v) { [].forEach.call($(id).children, function (b) { b.classList.toggle("on", b.getAttribute("data-v") === v); }); }
  function segGet(id) { var on = $(id).querySelector(".on"); return on ? on.getAttribute("data-v") : null; }
  ["sTheme", "sClock", "sCal"].forEach(function (id) {
    $(id).addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) segSet(id, b.getAttribute("data-v")); });
  });
  function openSettings() {
    var s = S.settings;
    $("sKey").value = ""; $("sKey").placeholder = s.hasKey ? "•••••••• (unchanged)" : "required";
    $("sUrl").value = s.url || ""; $("sWake").value = s.wake || "";
    segSet("sTheme", S.theme); segSet("sClock", S.clock); segSet("sCal", S.cal);
    $("about").textContent = "Hermes Display " + (s.version || "") + "  ·  " + (S.ambient ? S.ambient.place : "") + "  ·  wake: " + (s.wake || "");
    $("settings").classList.remove("hidden");
  }
  $("gear").addEventListener("click", function () { activity(); openSettings(); });
  $("closeSettings").addEventListener("click", function () { $("settings").classList.add("hidden"); });
  $("settings").addEventListener("click", function (e) { if (e.target === $("settings")) $("settings").classList.add("hidden"); });
  $("saveSettings").addEventListener("click", function () {
    var out = { url: $("sUrl").value.trim(), wake: $("sWake").value.trim(), theme: segGet("sTheme"), clock: segGet("sClock"), cal: segGet("sCal") };
    if ($("sKey").value.trim()) out.key = $("sKey").value.trim();
    if (Native) Native.saveSettings(JSON.stringify(out)); else HV.settings(Object.assign({}, S.settings, out, { hasKey: true }));
    $("settings").classList.add("hidden"); toast("Saved");
  });
  $("newConvo").addEventListener("click", function () { if (Native) Native.newConversation(); $("settings").classList.add("hidden"); setMode("ambient"); toast("New conversation"); });
  $("portalSettings").addEventListener("click", function () { if (Native) Native.portalSettings(); });
  $("mic").addEventListener("click", function () { activity(); if (Native) Native.tap(); else mockListen(); });
  document.addEventListener("touchstart", activity, { passive: true });
  document.addEventListener("mousedown", activity);

  // ------------------------------------------------------------------ API for native
  var HV = window.HV = {
    state: function (st, info) { setState(st, info); },
    level: function (v) { S.levelTarget = Math.max(0, Math.min(1, v)); S.levelAt = Date.now(); },
    turn: function (d) {
      S.lastTurnAt = Date.now();
      setMode("convo");
      if (!comet) launchComet(performance.now() / 1000);
      if (d.transcript) $("you").textContent = d.transcript;
      $("speech").className = "speech";
      $("speech").textContent = d.speech || d.reply || (d.transcript ? "" : "I didn’t catch that.");
      var card = $("card");
      if (d.display) { card.innerHTML = md(d.display); card.classList.remove("hidden"); } else card.classList.add("hidden");
      var t = d.timings || {}, parts = [];
      ["stt", "hermes", "tts"].forEach(function (k) { if (t[k] != null) parts.push(k.toUpperCase() + " " + t[k] + "s"); });
      $("meta").textContent = parts.join("   ·   ");
      $("elapsed").textContent = "";
      (d.actions || []).forEach(function (a) {
        if (a.type === "theme" && /^(day|night|auto)$/.test(a.mode)) { S.theme = a.mode; applyTheme(); if (Native) Native.saveSettings(JSON.stringify({ theme: a.mode })); }
      });
      if (!d.transcript) setTimeout(function () { if (S.state === "wake") setMode("ambient"); }, 2500);
    },
    asked: function (text) { setMode("convo"); $("you").textContent = text; },
    ambient: function (d) { S.ambient = d; renderWeather(); renderAgenda(); applyTheme(); $("net").className = "net ok"; },
    timers: function (list) { S.timers = list || []; renderTimers(); },
    ringing: function (r) {
      S.ringing = r; $("ring").classList.toggle("hidden", !r);
      if (r) { activity(); $("ringLabel").textContent = r.label || "Timer"; }
    },
    settings: function (s) {
      S.settings = s || {};
      if (s.theme) S.theme = s.theme; if (s.clock) S.clock = s.clock; if (s.cal) S.cal = s.cal;
      applyTheme(); tick(); renderWeather(); renderAgenda(); renderTimers();
    },
    toast: toast
  };

  // ------------------------------------------------------------------ boot
  mountWing($("wingTop")); mountWing($("wingOrb"));
  resize(); readRayColors(); renderChips(); tick();
  setInterval(tick, 1000);
  setInterval(renderChips, 15 * 60000);
  requestAnimationFrame(frame);
  if (Native) { Native.ready(); return; }

  // ------------------------------------------------------------------ mock (desktop browser only)
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00"; }
  function at(dayOff, h, m) { var d = new Date(); d.setDate(d.getDate() + dayOff); d.setHours(h, m, 0, 0); return iso(d); }
  var now = new Date(), nh = now.getHours();
  var hours = []; for (var k = 1; k <= 8; k++) { hours.push({ t: pad((nh + k) % 24) + ":00", temp: 55 - k, code: [0, 1, 2, 3, 61, 2, 0, 0][k - 1], pop: [0, 0, 10, 30, 60, 20, 0, 0][k - 1], day: (nh + k) % 24 < 17 ? 1 : 0 }); }
  var dd = []; for (var j = 1; j <= 4; j++) { var x = new Date(); x.setDate(x.getDate() + j); dd.push({ date: iso(x).slice(0, 10), hi: 60 + j, lo: 38 + j, code: [3, 61, 0, 2][j - 1], pop: [10, 70, 0, 10][j - 1] }); }
  var nowMin = nh * 60 + now.getMinutes();
  function ev(dayOff, mins, dur, title, loc, online) { return { title: title, start: at(dayOff, Math.floor(mins / 60), mins % 60), end: at(dayOff, Math.floor((mins + dur) / 60), (mins + dur) % 60), allDay: false, location: loc || "", online: !!online }; }
  var mockAmbient = {
    place: "Springfield", tz: "America/Chicago",
    weather: { temp: 55, feels: 52, code: 1, is_day: 1, wind: 7, humidity: 48, unit: "F", hi: 64, lo: 31, pop: 10, sunrise: "06:26", sunset: "16:37", hourly: hours, daily: dd },
    agenda: [
      ev(0, Math.max(0, nowMin - 180), 30, "Morning standup", "", true),
      ev(0, Math.max(0, nowMin - 20), 50, "Project sync", "Room 4B"),
      ev(0, Math.min(23 * 60, nowMin + 75), 30, "1:1 with Alex", "", true),
      ev(1, 9 * 60, 30, "Weekly planning", "Zoom", true),
      ev(1, 13 * 60 + 30, 60, "Design review — Hermes Display", "Studio")
    ],
    agenda_error: null
  };
  var scene = (location.hash.match(/scene=([\w-]+)/) || [])[1] || "ambient";
  var theme = (location.hash.match(/theme=(\w+)/) || [])[1] || "day";
  HV.settings({ url: "http://192.168.1.50:8650/voice", wake: "hey hermes", theme: theme, clock: "12", cal: "on", hasKey: true, version: "mock" });
  HV.ambient(mockAmbient);
  HV.timers([{ id: "t1", label: "Pasta", kind: "timer", endsAt: Date.now() + 9 * 60000 + 41000, total: 12 * 60000 }]);
  setState("wake");

  function mockListen() { setState("listening"); var v = 0; var iv = setInterval(function () { v += 0.2; HV.level(0.35 + 0.35 * Math.abs(Math.sin(v * 2.3))); }, 60); setTimeout(function () { clearInterval(iv); setState("thinking"); setTimeout(function () { mockTurn("Give me a quick recipe for scrambled eggs"); }, 1800); }, 2500); }
  function mockTurn(q) {
    setState("thinking");
    setTimeout(function () {
      HV.turn({
        transcript: q,
        speech: "Whisk a few eggs with a pinch of salt, cook them low and slow in butter, and take them off the heat while they're still glossy.",
        display: "# Scrambled Eggs\n1. **Whisk:** 2–3 eggs and a pinch of salt\n2. **Cook:** butter over low heat, stir slowly\n3. **Finish:** off the heat while still glossy; add chives",
        actions: [], timings: { stt: 0.62, hermes: 3.95, tts: 0.41 }
      });
      setState("speaking");
      var v = 0, iv = setInterval(function () { v += 0.25; HV.level(0.25 + 0.4 * Math.abs(Math.sin(v * 3.1) * Math.cos(v))); }, 60);
      setTimeout(function () { clearInterval(iv); setState("wake"); }, 6000);
    }, 1500);
  }
  if (scene === "listening") { setState("listening"); $("you").textContent = ""; setInterval(function () { HV.level(0.3 + 0.4 * Math.random()); }, 80); }
  if (scene === "thinking") { setMode("convo"); $("you").textContent = "What's on my calendar this afternoon?"; setState("thinking"); }
  if (scene === "card") { mockTurn("Give me a quick recipe for scrambled eggs"); setTimeout(function () { setInterval(function () { HV.level(0.2 + 0.5 * Math.random()); }, 80); }, 1600); }
  if (scene === "ring") HV.ringing({ label: "Pasta" });
  var dbB = (location.hash.match(/blink=([\d.]+)/) || [])[1], dbM = (location.hash.match(/mouth=([\d.]+)/) || [])[1];
  if (dbB != null) HArt.debug.blink = +dbB; if (dbM != null) HArt.debug.mouth = +dbM;
  if (scene === "settings") openSettings();
  if (scene === "sleep") { S.forceSleep = true; setSleeping(true); }
  window.addEventListener("keydown", function (e) {
    if (e.key === "l") mockListen(); if (e.key === "a") { setMode("ambient"); setState("wake"); }
    if (e.key === "r") HV.ringing(S.ringing ? null : { label: "Pasta" }); if (e.key === "n") { S.theme = S.theme === "night" ? "day" : "night"; applyTheme(); }
  });
})();
