/* Hermes Display — art engine.
 *
 * 1. The dither: a living 1-bit artwork in the Nous Research style — a sun with engraved rays rising
 *    over a drifting sea of clouds, crossed by horizontal signal bands. The scalar scene is rendered at
 *    quarter resolution and ordered-dithered (Bayer 4x4); CSS scales it up pixelated and a 4px mask
 *    turns every pixel into a 3x3 dot, giving the dot-matrix / halftone screen.
 * 2. The character: the Nous girl seal as Hermes' face. The outer text ring turns on its own (spins up
 *    while thinking, glows gold while listening); she breathes, blinks, glances, talks with the voice
 *    level, and glitches in the Nous manner when she materialises or thinks.
 *
 * The seal artwork is Nous Research's, included with their OK. It is not covered by this repo's MIT license.
 */
(function () {
  "use strict";
  var TAU = Math.PI * 2;
  var A = window.HArt = {};
  var col = { dither: [0, 0, 96], da: [0.22, 0.62], ray: [242, 242, 242], hot: [255, 201, 60], seal: "#F2F2F2", sealHot: "#FFC93C", line: "#0000F2" };
  function rgb(s) { return s.split(",").map(function (v) { return +v; }); }
  function smooth(e0, e1, x) { var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

  // ------------------------------------------------------------------ dither
  var dc, dctx, img, buf, lw = 0, lh = 0, lastDither = -1;
  var GLOW, FALL, BIN, HOLE, QUIET, NBIN = 2048, rayNow = new Float32Array(NBIN), rayPh = new Float32Array(NBIN), rayFq = new Float32Array(NBIN);
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(function (v) { return (v + 0.5) / 16; });
  var LUT = new Uint32Array(32), LUTH = new Uint32Array(32);
  for (var q = 0; q < NBIN; q++) { rayPh[q] = Math.random() * TAU; rayFq[q] = 0.15 + Math.random() * 0.5; }

  // tileable fbm value noise, 256x256, normalised to 0..1
  var NT = 256, TEX = (function () {
    var tex = new Float32Array(NT * NT), oct = [[8, 0.5], [16, 0.26], [32, 0.14], [64, 0.1]];
    oct.forEach(function (o) {
      var c = o[0], amp = o[1], lat = new Float32Array(c * c);
      for (var i = 0; i < c * c; i++) lat[i] = Math.random();
      for (var y = 0; y < NT; y++) {
        var fy = y * c / NT, iy = Math.floor(fy), ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
        var y0 = iy % c, y1 = (iy + 1) % c;
        for (var x = 0; x < NT; x++) {
          var fx = x * c / NT, ix = Math.floor(fx), tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
          var x0 = ix % c, x1 = (ix + 1) % c;
          var a = lat[y0 * c + x0] + (lat[y0 * c + x1] - lat[y0 * c + x0]) * tx;
          var b = lat[y1 * c + x0] + (lat[y1 * c + x1] - lat[y1 * c + x0]) * tx;
          tex[y * NT + x] += amp * (a + (b - a) * ty);
        }
      }
    });
    var mn = 1e9, mx = -1e9, k;
    for (k = 0; k < tex.length; k++) { if (tex[k] < mn) mn = tex[k]; if (tex[k] > mx) mx = tex[k]; }
    for (k = 0; k < tex.length; k++) tex[k] = (tex[k] - mn) / (mx - mn);
    return tex;
  })();
  function samp(u, v) {
    var iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
    var x0 = iu & 255, x1 = (iu + 1) & 255, y0 = (iv & 255) * NT, y1 = ((iv + 1) & 255) * NT;
    var a = TEX[y0 + x0] + (TEX[y0 + x1] - TEX[y0 + x0]) * fu;
    var b = TEX[y1 + x0] + (TEX[y1 + x1] - TEX[y1 + x0]) * fu;
    return a + (b - a) * fv;
  }

  function buildLUT() {
    for (var i = 0; i < 32; i++) {
      var a = Math.round(255 * (col.da[0] + (col.da[1] - col.da[0]) * i / 31)), c = col.dither, h = col.hot;
      LUT[i] = ((a << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
      LUTH[i] = ((Math.min(255, a + 40) << 24) | (h[2] << 16) | (h[1] << 8) | h[0]) >>> 0;
    }
  }
  A.initDither = function (canvas, W, H) {
    dc = canvas; lw = Math.ceil(W / 4); lh = Math.ceil(H / 4);
    dc.width = lw; dc.height = lh; dc.style.width = lw * 4 + "px"; dc.style.height = lh * 4 + "px";
    dctx = dc.getContext("2d"); img = dctx.createImageData(lw, lh); buf = new Uint32Array(img.data.buffer);
    var n = lw * lh, sx = lw * 1.02, sy = lh * 1.18;
    GLOW = new Float32Array(n); FALL = new Float32Array(n); BIN = new Uint16Array(n); HOLE = new Float32Array(n); QUIET = new Float32Array(n);
    for (var y = 0; y < lh; y++) for (var x = 0; x < lw; x++) {
      var i = y * lw + x, dx = x - sx, dy = y - sy, d = Math.sqrt(dx * dx + dy * dy);
      GLOW[i] = Math.exp(-Math.max(0, d - 34) / 80) * 0.95;
      FALL[i] = Math.exp(-d / 210) * smooth(30, 60, d);
      var a = Math.atan2(dy, dx); if (a < 0) a += TAU;
      BIN[i] = Math.floor(a / TAU * NBIN) % NBIN;
      // keep the clock and the agenda text clean: a soft hole behind each
      var cx1 = (x - lw * 0.2) / (lw * 0.22), cy1 = (y - lh * 0.27) / (lh * 0.2);
      var hole = Math.exp(-(cx1 * cx1 + cy1 * cy1));
      // quiet panels behind the agenda column and the weather block (soft-edged boxes)
      var agenda = smooth(lw * 0.58, lw * 0.64, x) * (1 - smooth(lh * 0.8, lh * 0.88, y)) * smooth(lh * 0.06, lh * 0.12, y);
      var wx = (1 - smooth(lw * 0.56, lw * 0.6, x)) * smooth(lh * 0.5, lh * 0.55, y) * (1 - smooth(lh * 0.84, lh * 0.88, y));
      hole = Math.max(hole, 0.35 * agenda, 0.25 * wx);
      QUIET[i] = 1 - Math.max(agenda, wx, Math.exp(-(cx1 * cx1 + cy1 * cy1)));
      GLOW[i] *= 1 - 0.7 * hole; FALL[i] *= 1 - 0.85 * hole; HOLE[i] = 1 - 0.9 * hole;
    }
    buildLUT();
  };

  var BANDS = [];
  function spawnBand(t, busy) {
    BANDS.push({ y: Math.random() * lh, x0: Math.random() * lw * 0.8, len: 20 + Math.random() * lw * 0.5, h: 1 + (Math.random() * 3 | 0),
      amp: 0.25 + Math.random() * 0.5, t0: t, life: 0.6 + Math.random() * (busy ? 1.2 : 3.5), v: (Math.random() - 0.5) * 6 });
  }

  // state: {amb, state, level, night}
  A.dither = function (t, st) {
    if (!dc || t - lastDither < 1 / 8) return;
    var dt = lastDither < 0 ? 0 : t - lastDither; lastDither = t;
    var busy = st.state === "thinking";
    if (Math.random() < dt * (busy ? 5 : 0.45)) spawnBand(t, busy);
    // rays: a slowly rotating engraved profile, each ray breathing on its own
    var rot = Math.floor(t * 0.9) % NBIN, bright = 1 + (st.state === "listening" || st.state === "speaking" ? 0.7 * st.level : 0);
    for (var b = 0; b < NBIN; b++) {
      var a = (b + rot) / NBIN * TAU;
      var p = 0.5 + 0.5 * Math.cos(a * 64 + 2.4 * Math.sin(a * 9));
      p = p * p; p = p * p; p = p * p;
      rayNow[b] = p * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * rayFq[b] + rayPh[b]))) * 0.75 * bright;
    }
    var dim = 0.5 + 0.5 * st.amb, breathe = 1 + 0.06 * Math.sin(t * 0.5), y0 = Math.floor(lh * 0.5);
    var cu1 = t * 2.4, cu2 = -t * 1.3 + 97, i = 0;
    // two slow light-blobs wandering the sky (Lissajous paths, ~2–3 min loops)
    var g1x = lw * (0.3 + 0.22 * Math.sin(t * 0.041)), g1y = lh * (0.25 + 0.15 * Math.sin(t * 0.057 + 1)), g1r = 1 / (lw * lw * 0.05);
    var g2x = lw * (0.62 + 0.25 * Math.sin(t * 0.033 + 2)), g2y = lh * (0.45 + 0.2 * Math.cos(t * 0.047)), g2r = 1 / (lw * lw * 0.035);
    for (var y = 0; y < lh; y++) {
      var row = y * lw, by = (y & 3) * 4, ramp = y < y0 ? 0 : smooth(y0, lh * 0.93, y);
      for (var x = 0; x < lw; x++, i++) {
        var q1 = (x - g1x) * (x - g1x) + (y - g1y) * (y - g1y), q2 = (x - g2x) * (x - g2x) + (y - g2y) * (y - g2y);
        var w1 = 1 / (1 + q1 * g1r), w2 = 1 / (1 + q2 * g2r);
        var f = GLOW[i] * breathe + FALL[i] * rayNow[BIN[i]] + 0.2 * w1 * w1 * HOLE[i] + 0.16 * w2 * w2 * HOLE[i];
        if (ramp > 0) {
          var n = 0.62 * samp(x * 0.8 + cu1, y * 1.7) + 0.38 * samp(x * 0.5 + cu2, y * 1.2 + 41);
          f += smooth(0.4, 0.78, n) * ramp * (0.5 + 0.7 * GLOW[i] + 0.25 * ramp) * HOLE[i];
        }
        f *= dim;
        var th = BAYER[by + (x & 3)];
        buf[i] = f > th ? LUT[Math.min(31, (f * 31) | 0)] : 0;
      }
    }
    // signal bands: glitchy horizontal dashes in the hot colour
    for (var k = BANDS.length - 1; k >= 0; k--) {
      var B = BANDS[k], age = (t - B.t0) / B.life;
      if (age >= 1) { BANDS.splice(k, 1); continue; }
      var env = Math.sin(Math.PI * age), by0 = Math.floor(B.y + (t - B.t0) * B.v);
      var xs = Math.max(0, Math.floor(B.x0 + (t - B.t0) * 30)), xe = Math.min(lw, Math.floor(xs + B.len));
      for (var yy = by0; yy < by0 + B.h; yy++) {
        if (yy < 0 || yy >= lh) continue;
        for (var xx = xs; xx < xe; xx++) {
          var v = B.amp * env * (0.35 + 0.65 * TEX[((yy * 7) & 255) * NT + ((xx * 3 + (t * 40 | 0)) & 255)]);
          v *= QUIET[yy * lw + xx];
          if (v > BAYER[(yy & 3) * 4 + (xx & 3)]) buf[yy * lw + xx] = LUTH[Math.min(31, (v * 40) | 0)];
        }
      }
    }
    dctx.putImageData(img, 0, 0);
  };

  // ------------------------------------------------------------------ four-point sparkles
  A.sparkle = function (ctx, x, y, r, alpha, color) {
    if (alpha <= 0.01 || r <= 0.3) return;
    ctx.fillStyle = "rgba(" + color + "," + alpha.toFixed(3) + ")";
    var w = r * 0.16;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.quadraticCurveTo(x + w, y - w, x + r, y); ctx.quadraticCurveTo(x + w, y + w, x, y + r);
    ctx.quadraticCurveTo(x - w, y + w, x - r, y); ctx.quadraticCurveTo(x - w, y - w, x, y - r); ctx.fill();
    if (r > 6) { ctx.globalAlpha = alpha * 0.35; ctx.beginPath(); ctx.arc(x, y, r * 0.22, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
  };

  // ------------------------------------------------------------------ the character (Nous girl seal)
  // Seal canvas coordinates: 983 x 983 (the SVG viewBox), centre 491.5, outer radius 491.5,
  // solid inner circle at r≈400 separating the text ring from the portrait.
  var SEAL_N = 983, SEAL_C = 491.5, RING_IN = 400.5 / 491.5;
  var EYE_R = { x: 412, y: 404, rx: 47, ry: 28, rot: 0.19 };  // her left eye (large, right side of image)
  var EYE_L = { x: 303, y: 418, rx: 22, ry: 30, rot: -0.12 }; // her right eye (far side, foreshortened)
  var MOUTH = { x: 342, y: 523, w: 25, rot: 0.12 };
  var seal = { img: new Image(), ready: false, key: "", paper: null, hot: null, size: 0 };
  seal.img.onload = function () { seal.ready = true; seal.key = ""; };
  seal.img.src = "seal.svg";
  function tint(size, color) {
    var c = document.createElement("canvas"); c.width = c.height = size;
    var g = c.getContext("2d"); g.drawImage(seal.img, 0, 0, size, size);
    g.globalCompositeOperation = "source-in"; g.fillStyle = color; g.fillRect(0, 0, size, size);
    return c;
  }
  function ensureTints(size) {
    var key = size + col.seal + col.sealHot;
    if (!seal.ready || seal.key === key) return seal.ready;
    seal.paper = tint(size, col.seal); seal.hot = tint(size, col.sealHot); seal.size = size; seal.key = key;
    return true;
  }

  var ch = { ring: 0, ringV: 0.05, blink: 0, nextBlink: 0, blinkT: -1, mouth: 0, look: 0, lookT: 0, nextLook: 0, glitch: 0, hotAmt: 0, lastT: 0, scan: 0 };
  A.debug = {};

  function eyeLid(g, e, k, c) {
    // c = closedness 0..1. Paper "skin" slides down over the eye; a lid line rides its lower edge.
    if (c <= 0.02) return;
    g.save();
    g.translate(e.x * k, e.y * k); g.rotate(e.rot);
    var rx = e.rx * k, ry = e.ry * k;
    g.save();
    g.beginPath(); g.ellipse(0, 0, rx * 1.08, ry * 1.12, 0, 0, TAU); g.clip();
    var edge = -ry * 1.12 + c * ry * 1.95;
    g.fillStyle = col.seal;
    g.fillRect(-rx * 1.2, -ry * 1.3, rx * 2.4, edge + ry * 1.3);
    g.restore();
    g.strokeStyle = col.line; g.lineCap = "round"; g.lineWidth = Math.max(1.2, 6 * k);
    var sag = (0.25 + 0.55 * c) * ry * 0.5;
    g.beginPath(); g.moveTo(-rx * 1.02, edge - sag * 0.4); g.quadraticCurveTo(0, edge + sag, rx * 1.02, edge - sag * 0.2); g.stroke();
    g.restore();
  }
  function mouth(g, k, m) {
    if (m <= 0.03) return;
    g.save();
    g.translate(MOUTH.x * k, MOUTH.y * k); g.rotate(MOUTH.rot);
    var w = MOUTH.w * k * (0.8 + 0.35 * m), h = (3 + 26 * m) * k;
    g.fillStyle = col.line;
    g.beginPath();
    g.moveTo(-w, 0);
    g.quadraticCurveTo(-w * 0.2, -h * 0.55, w * 0.9, -h * 0.1);
    g.quadraticCurveTo(w * 0.1, h * 1.25, -w, 0);
    g.fill();
    g.restore();
  }

  // Draw the seal centred at (x, y) with outer radius R onto ctx.
  // st: {state, level, mode alpha, t, dt, appear(0..1)}
  A.character = function (ctx, x, y, R, t, st) {
    var size = Math.round(R * 2);
    if (!ensureTints(size)) return;
    var dt = Math.min(0.1, t - (ch.lastT || t)); ch.lastT = t;
    var state = st.state, lvl = st.level || 0, alpha = st.alpha == null ? 1 : st.alpha, k = size / SEAL_N;

    // ring spin: idle drift, fast while thinking
    var targetV = state === "thinking" ? 1.6 : state === "listening" ? 0.25 : 0.05;
    ch.ringV += (targetV - ch.ringV) * Math.min(1, dt * 3);
    ch.ring += ch.ringV * dt;
    ch.hotAmt += ((state === "listening" ? 1 : 0) - ch.hotAmt) * Math.min(1, dt * 6);

    // blink every 2.5–6 s (double-blink sometimes); eyes shut while "thinking hard" briefly
    if (!ch.nextBlink) ch.nextBlink = t + 1.5;
    if (t > ch.nextBlink && ch.blinkT < 0) { ch.blinkT = t; ch.nextBlink = t + 2.5 + Math.random() * 3.5; if (Math.random() < 0.2) ch.nextBlink = t + 0.35; }
    var c = 0;
    if (ch.blinkT >= 0) { var u = (t - ch.blinkT) / 0.2; if (u >= 1) ch.blinkT = -1; else c = Math.sin(Math.PI * u); }
    if (A.debug.blink != null) c = A.debug.blink;

    // mouth follows the voice level while speaking
    var mt = state === "speaking" ? Math.min(1, lvl * 1.5) : 0;
    if (A.debug.mouth != null) mt = A.debug.mouth;
    ch.mouth += (mt - ch.mouth) * Math.min(1, dt * 18);

    // glitch: on materialise, while thinking, and in small bursts when speaking loudly
    var g0 = (1 - (st.appear == null ? 1 : st.appear)) * 1.0;
    if (state === "thinking" && Math.random() < dt * 2.2) ch.glitch = 0.6 + Math.random() * 0.4;
    if (state === "speaking" && lvl > 0.75 && Math.random() < dt * 1.2) ch.glitch = 0.35;
    ch.glitch = Math.max(0, ch.glitch - dt * 2.8);
    var gl = Math.max(g0, ch.glitch);

    // gentle float
    var bob = Math.sin(t * 1.1) * R * 0.012 + (state === "speaking" ? lvl * R * 0.01 : 0);

    ctx.save();
    ctx.globalAlpha = alpha;

    // the ring of text, turning
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.arc(x, y, R * RING_IN, 0, TAU, true); ctx.clip();
    ctx.translate(x, y); ctx.rotate(ch.ring);
    ctx.drawImage(seal.paper, -R, -R, size, size);
    if (ch.hotAmt > 0.02) { ctx.globalAlpha = alpha * ch.hotAmt; ctx.drawImage(seal.hot, -R, -R, size, size); }
    ctx.restore();

    // the portrait, with eyes and mouth composed on an offscreen layer so overlays share the glitch
    if (!ch.layer || ch.layer.width !== size) { ch.layer = document.createElement("canvas"); ch.layer.width = ch.layer.height = size; ch.lctx = ch.layer.getContext("2d"); }
    var L = ch.lctx;
    L.clearRect(0, 0, size, size);
    L.save(); L.beginPath(); L.arc(size / 2, size / 2, R * RING_IN - 0.5, 0, TAU); L.clip();
    L.drawImage(seal.paper, 0, 0);
    eyeLid(L, EYE_R, k, c); eyeLid(L, EYE_L, k, c);
    mouth(L, k, ch.mouth);
    L.restore();

    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, R * RING_IN, 0, TAU); ctx.clip();
    var ox = x - R, oy = y - R + bob;
    if (gl > 0.02) {
      var strips = 26, sh = size / strips;
      for (var s = 0; s < strips; s++) {
        var n = Math.sin(s * 12.9898 + Math.floor(t * 14) * 78.233) * 43758.5453; n -= Math.floor(n);
        var off = n > 0.6 ? (n - 0.6) / 0.4 * gl * R * 0.22 * (s % 2 ? 1 : -1) : 0;
        if (n > 0.9 && gl > 0.4) continue; // dropped scanline
        ctx.drawImage(ch.layer, 0, s * sh, size, sh, ox + off, oy + s * sh, size, sh);
      }
      // chromatic hot echo
      ctx.globalAlpha = alpha * gl * 0.5;
      ctx.drawImage(seal.hot, 0, 0, size, size, ox + gl * R * 0.05, oy, size, size);
      ctx.globalAlpha = alpha;
    } else {
      ctx.drawImage(ch.layer, ox, oy);
    }
    // thinking: a scanline sweeping down the portrait
    if (state === "thinking") {
      ch.scan = (ch.scan + dt * 0.7) % 1;
      var sy = y - R * RING_IN + ch.scan * R * RING_IN * 2;
      var grad = ctx.createLinearGradient(0, sy - R * 0.25, 0, sy);
      grad.addColorStop(0, "rgba(" + col.hot.join(",") + ",0)"); grad.addColorStop(1, "rgba(" + col.hot.join(",") + ",0.28)");
      ctx.fillStyle = grad; ctx.fillRect(x - R, sy - R * 0.25, R * 2, R * 0.25);
      ctx.fillStyle = "rgba(" + col.hot.join(",") + ",0.7)"; ctx.fillRect(x - R, sy, R * 2, 1.5);
    }
    ctx.restore();

    // eye glints: a tiny four-point sparkle now and then while she talks or listens
    if (state === "speaking" || state === "listening") {
      var gp = 0.5 + 0.5 * Math.sin(t * 3.1);
      A.sparkle(ctx, x - R + (EYE_R.x - 18) * k, y - R + bob + (EYE_R.y - 12) * k, R * 0.035 * (0.6 + gp), 0.9 * gp, "255,255,255");
    }
    ctx.restore();
  };

  // Small static coin for the dock mic.
  A.coin = function (ctx, x, y, r) {
    if (!ensureTints(seal.size || 336)) return;
    ctx.drawImage(seal.paper, x - r, y - r, r * 2, r * 2);
  };

  A.setColors = function (c) {
    if (c.dither) col.dither = rgb(c.dither); if (c.da) col.da = rgb(c.da);
    if (c.ray) col.ray = rgb(c.ray); if (c.hot) col.hot = rgb(c.hot);
    if (c.seal) col.seal = c.seal; if (c.sealHot) col.sealHot = c.sealHot; if (c.line) col.line = c.line;
    buildLUT(); seal.key = "";
  };
})();
