# Design notes

The screen is a web page (`android/app/src/main/assets/ui/`): `app.js` holds state and the sky, `art.js` the dither
and the character, `app.css` the layout. It targets the Portal 10" at 1280×800.

## Look

Built from Hermes' own visual identity.

- **Day**: the Hermes Agent web look. Electric blue `#0000F2`, off-white `#F2F2F2`, navy `#000091`; Oswald for
  display type, JetBrains Mono for uppercase tracked labels, sharp corners, hairline rules.
- **Night**: the Hermes CLI's default skin. Gold `#FFD700` and amber `#FFBF00` with bronze rules on near-black ink.
  It switches 30 minutes after sunset (from the weather data). From 23:00 to 06:00, after 90 s idle, the screen dims to
  a clock.

## Screens

- **Ambient**: big clock and date; current weather, an 8-hour strip and a 4-day forecast; a "next up" card; today's and
  tomorrow's agenda with past events dimmed; suggestion chips that change with the time of day.
- **Conversation**: your words, Hermes' spoken answer in large type, and the `<display>` card (headings, lists,
  tables). It drifts back to ambient after 45 s.
- **Timers**: chips in the top bar with a countdown, ✕ to cancel. When one ends, a full-screen alarm rings until you
  tap, say "stop timer", "stop alarm" or the wake phrase, or 2 minutes pass. A bare "stop" was being decoded from the
  alarm tone itself, so stop phrases are two words and are ignored for the first 2 seconds.
- **Settings** (gear): key, bridge URL, wake phrases, theme, 12/24-hour clock, calendar on or off, new conversation,
  Portal settings.

## The sky

The background is a slow "celestial engraving" drawn on one canvas:

- **Sun and astrolabe.** A ray-burst sun sits just past the bottom-right corner. Graduated rings with Roman numerals
  turn around it, about 9× faster while Hermes is thinking.
- **Mercury.** Hermes' planet rises and sets along one orbit, one pass every 2.5 minutes or so.
- **Motes** drift off the sun, quicker while you talk. **Caduceus**: two braided strands flow along the dock line.
- **Night stars** twinkle in the night theme. A **comet** crosses every 35 to 85 seconds, and on every reply.

## Art and character

- `art.js` renders a living 1-bit artwork at quarter resolution with Bayer 4×4 ordered dithering: a sun with engraved
  rays, a drifting cloud sea, and glitchy signal bands that multiply while Hermes thinks. CSS scales it up pixelated and
  masks each pixel to a 3×3 dot, for a halftone look. The dither thins behind the clock, weather and agenda so text
  stays readable.
- The seal is Hermes' face in conversation, set inside the ray-burst. The text ring turns on its own (faster while
  thinking, gold while listening). She breathes, blinks, and her mouth opens with the level of the reply audio, read
  through Android's `Visualizer`. She glitches into view, and a scanline sweeps over her while thinking. The dock's mic
  button shows the seal as a coin.

The wing mark and the seal are Nous Research artwork, included with their OK.

## Performance on the Portal's WebView

The lesson that shaped the code: on this WebView, **every always-on CSS animation forces a 60 Hz redraw of the whole
app view**, costing about 60% of a core on the main thread.

- So there are no infinite CSS animations. All motion lives in the canvas loop: 15 fps when idle, 30 fps in
  conversation or while a comet is up, and the dither at 8 fps.
- Strokes are batched into alpha buckets instead of being drawn one by one.
- The clock colon and the "now" dot toggle from the one-second tick.
- Idle cost: about 40% of one core for the app (including the wake word) and about 33% for the renderer, out of 8 cores.

If you add motion, add it to the canvas loop. If you add a CSS animation, measure before and after on the device:
see [portal.md](portal.md#profiling-on-the-device).

## Trying things on a desktop

The page runs with mock data in a browser, including every scene and both themes:
see [portal.md](portal.md#preview-the-screen-without-a-portal). The mock also takes `&blink=1&mouth=0.8` to pose the
character.
