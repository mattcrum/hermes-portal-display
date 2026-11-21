# Wake word

"Hey Hermes" is detected on the Portal, offline, by [Vosk](https://alphacephei.com/vosk/) with its small English model.
Vosk is a speech recognizer, not a wake-word engine; it was chosen because a custom phrase needs no training run and
no vendor account. This file explains how it is made to behave like a wake word, what was measured, and how to tune it.
`android/tools/wake_harness.py` reproduces the numbers offline.

## Stage 1: a phrase spotter with decoys
Restricting the recognizer to a tiny grammar turns it into a phrase spotter. With a grammar of only
`"hey hermes"` + `[unk]`, a bare "hey" or "hi" plus room noise woke it every time: the decoder had nothing better to
call it. So the grammar also holds decoys (`hey hi hello okay ok hermes her hers mess homes herman hermit "hey there"`,
plus each word of the wake phrase), and the phrase must match as whole words in **2 consecutive partial results** (or a
final result). In testing with TTS voices at three noise levels, that removed every false wake from "hey", "hi", "ok",
"hey there", "hey google" and "I said hey to Herman", and kept every real one.

## The podcast problem
With a podcast on the room speakers, "hey hermes" fired almost constantly. Stage 1 is Vosk small-en-us restricted to a
grammar of `"hey hermes"` + ~13 decoys + `[unk]`. A grammar-restricted decoder must explain *all* audio with those
words, so continuous speech keeps collapsing to "hey hermes". The decoys (v0.2.1) only fixed a bare "hey" or "hi".
Measured: about 4 false wakes per minute on an adversarial script.

## Fix: two-stage detection
```
mic ─► WakeListener audio thread (200 ms chunks, 3 s ring buffer)
         │ stage 1: grammar spotter → partial/final posted to main
         ▼
       MainActivity.onWakeText: phrase in 2 consecutive partials (or a final) = "candidate"
         │ verifying = true; speech.requestVerify()
         ▼
       audio thread waits POST_MS (300 ms) more audio, then stage 2:
         same Model, Recognizer WITHOUT grammar, setMaxAlternatives(5), decode the last WINDOW_MS (2.2 s)
         PASS if any alternative contains a word in ACCEPT {hermes, herms, hermes's, hermes'}
         ▼
       MainActivity.onWakeVerdict → onWake() on PASS; on reject, spotter.reset() and keep listening
```
Why it works: without a grammar, podcast audio decodes to what was actually said ("hey hurry up", "her mother's
coming", "hey herman how"), while a real "hey hermes" decodes with `hermes` in the 5-best.

## Code map
- `android/app/src/main/java/io/github/mattcrum/hermesdisplay/WakeListener.kt`: replaces Vosk's `SpeechService` so the app
  keeps the raw PCM. It owns the AudioRecord, the ring buffer, both stages' decoding on the `wake-audio` thread,
  `saveClip()`, and the debug WAV replay (`testWav`).
- `MainActivity.kt`
  - `buildRecognizer()`: creates the `verifier` once (5-best, warmed up on 0.5 s of silence; the first cold decode
    took 1.5 s).
  - `onWakeText()`: stage-1 logic (streak, ringing stop phrases). It skips stage 2 if the wake phrase contains no
    `ACCEPT` word (custom phrases).
  - `onWakeVerdict()`: acts on PASS unless `replaying`.
  - `startWakeListener()` / `stopWake()`: build and stop a `WakeListener`; `verifying` is reset on both.
  - `onNewIntent()`: debug-only `wake_test` extra (FLAG_DEBUGGABLE). It starts the replay 1 s later, because
    `onResume` → `goWake()` restarts the listener and would kill an immediate replay.
- `android/tools/wake_harness.py`: an offline mirror of both stages for the Mac. Keep its constants in sync with the Kotlin.

## Invariants / gotchas (each one cost a debug cycle)
1. **Vosk aborts the whole process** (native `KaldiFatalError`, can't be caught) on `setGrammar()` while a recognizer
   stream is "running". `WakeListener.loop()`'s `finally` calls `spotter.finalResult` so `startWakeListener()` can
   call `setGrammar()` safely. Never call `setGrammar` on a recognizer that has accepted audio without finalizing it.
2. Both recognizers are used **only on the audio thread** while it runs. `stop()` joins the thread (1.5 s cap) before
   the main thread touches them again. `takePreroll()` reads the ring only if that join succeeded.
3. `verifying` gates `onWakeText`: stale partials already queued on the main looper are ignored until the verdict
   arrives, so one candidate can't trigger two verifies.
4. While a timer/alarm rings, stop phrases and the wake phrase act on stage 1 alone (no verify).
5. Barge-in during SPEAKING goes through stage 2 too. The Portal's echo cancellation already hides most of its own
   voice (a 40 s reply produced 2 partials).
6. Test WAVs need a plain 44-byte header: make them with `ffmpeg ... -ar 16000 -ac 1 -bitexact -map_metadata -1`.

## Measurements
| test | stage 1 only | + stage 2 |
|---|---|---|
| adversarial script, Mac, 10 `say` voices (~25 min) | 100–106 | 2–4 |
| same script replayed on the Portal (5 min, 2 voices) | 20 | 1 |
| "hey hermes", quiet (Mac 18–20 clips) | 18/20 | 17–18/20 |
| "hey hermes", Portal replay | 6/6 | 6/6 |
| "hey hermes" with a podcast at 0.2 / 0.35 gain underneath (Mac) | n/a | 14/20, 10–12/20 |

Stage-2 cost on the Portal (SD835): 350–530 ms decode, plus the 300 ms tail. On-device timings are in logcat.
The remaining false passes are lines that really say "hey … hermes" (the script's "Hermes bag" line).

Not yet tested with **real podcast audio through real speakers**. The Mac's speakers don't reach the Portal's mic.

## How to test / tune
```bash
adb logcat -s PortalVoice:I            # "wake candidate: …" and "wake verify PASS|reject in N ms: <5-best>"
adb pull /sdcard/Android/data/io.github.mattcrum.hermesdisplay/files/wake ./wake-clips   # last 30 stage-1 windows, <ms>-pass|reject.wav
python android/tools/wake_harness.py --real ./wake-clips                          # re-score real clips offline
adb push x.wav /sdcard/Android/data/io.github.mattcrum.hermesdisplay/files/wake-test/
adb shell am start -n io.github.mattcrum.hermesdisplay/.MainActivity --es wake_test x.wav  # replay through the device pipeline (logs only)
```
The saved clips are room audio and stay on the device. Never upload them anywhere; don't commit them.

## Knobs, for more or fewer wakes
- **Still too many false wakes:** drop `herms` from `ACCEPT`; require `hermes` to directly follow `hey`/`hi`/`a` in an
  alternative; or use fewer alternatives (`NALT` 5 → 1). Each costs recall in noise (Mac: 5-best gave 17/18 at noise
  300 vs 15/18 for 1-best). Re-run the harness after any change.
- **Misses real wakes over a podcast:** a bigger verifier model (e.g. vosk-model-en-us-0.22-lgraph, ~128 MB) only for
  stage 2; or `WINDOW_MS` 1.6 s, so less podcast speech is in the window (barely helped in testing).
- **Too slow:** lower `POST_MS`. "hermes" may then be cut off at the window's end, so check recall.

## Pre-roll: one-breath questions
Stage 2 costs 0.7–1.6 s between the wake phrase and the mic re-opening (measured on the Portal: 300 ms tail, a
0.25–1.2 s decode, then the hand-over). At first that audio was thrown away, so "hey hermes, what time is it" said
without a pause lost the whole question.

- `WakeListener`: after a PASS it stops spotting and keeps buffering (`holding`). `stop()` then drains what queued in
  the AudioRecord buffer while stage 2 decoded (`MIC_BUF_MS`, 2 s; it was 400 ms and overran). `takePreroll()` returns
  the ring from `PRE_MS` (150 ms) before the stage-1 hit to that point. If nobody collects it within `HOLD_MS` (3 s), or
  the app calls `resume()`, it goes back to spotting.
- `MainActivity.onWake()` passes the pre-roll to `startCapture()`. `speechIn()` decides whether someone is already
  talking in it: 20 ms frames, the first 350 ms skipped (the end of "hermes"), at least 300 ms of loud frames. If so, the
  pre-roll is prepended to the recording, counts as heard speech for the 1.2 s end-of-speech timer, and the beep is
  skipped. If not, the pre-roll is dropped and the capture behaves exactly as before (beep, 6 s to start talking).
- A custom wake phrase (stage 1 only) has no pre-roll.

Checked offline (same `say` clips) and by replay on the Portal: 9/9 "hey Hermes, what time is it?" clips keep the whole
question (before: a stray word or nothing), and 9/9 bare "hey hermes" clips are judged "not talking". A debug replay saves
each pre-roll as `<ms>-preroll.wav` next to the pass/reject clips. **Not yet tested with a real voice at the device**;
logcat prints `wake preroll N ms, speech=true|false` on every wake.

## Open issues
- **Speech that mentions Hermes still wakes it.** Stage 2 accepts any window containing `hermes`. A 3-minute `say`
  script that talks about Hermes gave 16 false wakes from 17 candidates. Requiring `hermes` in the last two words *and*
  a hey-like word before it cut that to 3 with quiet wakes unchanged (18/20), but wakes over a podcast fell from 14 to
  11 of 20. Decide with real clips from `files/wake`, not TTS voices.
- **A ringing alarm is stopped on stage 1 alone** (invariant 4). Simulated without the alarm tone, podcast-style speech
  silenced it in 2–28 s. Consider sending ring-stop through stage 2 as well.
- **The mic hears almost nothing while the speaker plays.** Hermes saying "Hey Hermes" three times produced no
  candidates, which is good, but it also suggests spoken barge-in and "stop alarm" over the ringtone may not get
  through. Neither has been tested by voice.

## Options considered and rejected
- Picovoice Porcupine: needs a vendor account and key, which this project avoids.
- openWakeWord custom model: the best long-term fix, but it needs a training run (synthetic TTS data in Colab) and
  model plumbing. Worth revisiting if stage 2 isn't enough.
- Verifying on the bridge with faster-whisper: adds a network round trip and would upload ~2 s of room audio to the
  server several times a minute while a podcast plays. Rejected for privacy and latency.
- Home Assistant's voice pipeline: ruled out. The project is deliberately self-contained.

## Status
The two-stage detector and the pre-roll are part of the app. They have been tested with TTS voices and
replayed clips, and in daily use, but not yet measured with real podcast audio through real room speakers.
