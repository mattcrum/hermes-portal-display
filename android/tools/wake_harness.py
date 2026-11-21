#!/usr/bin/env python3
"""
Offline wake-word harness: mirrors the app's two-stage detector (MainActivity.onWakeText + WakeListener) on the Mac.

    python3 -m venv /tmp/wakevenv && /tmp/wakevenv/bin/pip install vosk numpy
    /tmp/wakevenv/bin/python android/tools/wake_harness.py            # make clips (macOS `say`) if missing, then test
    /tmp/wakevenv/bin/python android/tools/wake_harness.py --real DIR # also score your own WAVs (16 kHz mono), e.g. the
                                                                      # clips pulled from the Portal's files/wake/

Keep GRAMMAR/DECOYS/ACCEPT/timings in sync with the Kotlin constants, or the numbers stop meaning anything.
"""
import argparse, glob, json, os, re, subprocess, sys, wave
import numpy as np
from vosk import KaldiRecognizer, Model, SetLogLevel

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "..", "app", "src", "main", "assets", "model-en-us")
CLIPS = os.path.join(HERE, "wake-clips")          # git-ignored
RATE = 16000
WAKE = "hey hermes"
DECOYS = ["hey", "hi", "hello", "okay", "ok", "hermes", "her", "hers", "mess", "homes", "herman", "hermit", "hey there"]
ACCEPT = {"hermes", "herms", "hermes's", "hermes'"}   # WakeListener.ACCEPT
WAKE_STREAK, CHUNK, WINDOW_S, POST_MS, NALT = 2, RATE // 5, 2.2, 300, 5

VOICES = ["Samantha", "Daniel", "Fred", "Eddy (English (US))", "Flo (English (UK))", "Grandpa (English (US))",
          "Karen", "Moira", "Rishi", "Tessa"]
# Deliberately adversarial "podcast": lots of "hey" + her-/herm- words. Real podcasts are far easier.
SCRIPT = """Hey everybody, welcome back to the show. Today we're talking about her messy desk, and honestly, hey, it's a
mess. So I said to Herman, hey, where's the hermit crab? He says, it's at her house, the homes are all the same down
there. Okay, so let's get into it. Hi to everyone listening from the car. Hello to the folks who wrote in last week.
Hey, here's a thing. Her emails were like, hermetically sealed, nobody could read them. Hey there, I'm going to tell
you about the Hermes bag that my sister bought, it cost a fortune. Okay okay. Hey, hers is better than mine. Her mess
is her business. Hey, Herb, how's it going? Hey, hurry up. Hey, her name is Mary. They were hermits for years in the
mountains. Hey listen, the heroes of this story are the nurses. Hey, homies. Hey, hammers and nails. Hey, her mother's
coming over. Hey, hermeneutics is a word I never use. Hey, have you heard of mercury? Hey, Hermione is my favorite
character. Here, miss, take this. Hey her, me, us, all of us. Hey Harmon, nice to see you. Hey Herman, how are you.
They her missus said hello. Hey Thomas. Hey, Herbert. Alright, we'll be right back after the break."""


def make_clips():
    os.makedirs(CLIPS, exist_ok=True)
    for v in VOICES:
        n = re.sub(r"[^A-Za-z]", "", v)
        for name, text in [(f"pod_{n}", SCRIPT), (f"wake_{n}_short", "hey hermes"), (f"wake_{n}_q", "hey Hermes, what time is it?")]:
            out = os.path.join(CLIPS, name + ".wav")
            if os.path.exists(out):
                continue
            aiff = out[:-4] + ".aiff"
            if subprocess.run(["say", "-v", v, "-o", aiff, text], capture_output=True).returncode:
                print("skip voice", v); break
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", aiff, "-ar", str(RATE), "-ac", "1",
                            "-bitexact", "-map_metadata", "-1", out], check=True)
            os.remove(aiff)


def load(p):
    w = wave.open(p)
    assert w.getframerate() == RATE and w.getnchannels() == 1, f"{p}: need 16 kHz mono"
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32)


def has(text, phrase):
    return re.search(r"(^| )" + re.escape(phrase) + r"( |$)", text) is not None


class Detector:
    def __init__(self, model):
        self.model = model
        self.grammar = json.dumps([WAKE] + [d for d in DECOYS if d != WAKE] + ["[unk]"])
        self.verifier = KaldiRecognizer(model, RATE)
        self.verifier.SetMaxAlternatives(NALT)

    def verify(self, seg):
        self.verifier.Reset()
        self.verifier.AcceptWaveform(seg.astype(np.int16).tobytes())
        r = json.loads(self.verifier.FinalResult())
        texts = [a.get("text", "") for a in r.get("alternatives", [r])]
        return any(ACCEPT & set(t.split()) for t in texts), " | ".join(texts[:3])

    def run(self, audio, stage2=True, noise=0.0):
        """Returns (stage-1 hits, list of (seconds, verifier text) for wakes that would fire)."""
        a = np.concatenate([np.zeros(RATE // 2), audio, np.zeros(RATE + RATE // 2)]).astype(np.float32)
        if noise:
            a = a + np.random.default_rng(1).normal(0, noise, a.shape)
        a = np.clip(a, -32768, 32767)
        rec = KaldiRecognizer(self.model, RATE, self.grammar)
        streak, hits, wakes, i, pending = 0, 0, [], 0, None
        while i < len(a):
            c = a[i:i + CHUNK]; i += len(c)
            if pending is not None:
                if i < pending:
                    continue
                ok, heard = self.verify(a[max(0, pending - int(WINDOW_S * RATE)):pending]) if stage2 else (True, "")
                if ok:
                    wakes.append((round(i / RATE, 1), heard))
                pending, streak = None, 0
                rec.Reset()
                continue
            if rec.AcceptWaveform(c.astype(np.int16).tobytes()):
                t = json.loads(rec.Result()).get("text", "")
                hit, streak = has(t, WAKE), 0
            else:
                t = json.loads(rec.PartialResult()).get("partial", "")
                streak = streak + 1 if t and has(t, WAKE) else 0
                hit = streak >= WAKE_STREAK
            if hit:
                hits += 1
                pending = i + POST_MS * RATE // 1000
        return hits, wakes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--real", help="directory of extra 16 kHz mono WAVs to score (prints per-file verdicts)")
    args = ap.parse_args()
    SetLogLevel(-1)
    make_clips()
    d = Detector(Model(MODEL))
    pods = sorted(glob.glob(os.path.join(CLIPS, "pod_*.wav")))
    wakes = sorted(glob.glob(os.path.join(CLIPS, "wake_*.wav")))
    for noise in (0, 300):
        for stage2 in (False, True):
            fp = sum(len(d.run(load(p), stage2, noise)[1]) for p in pods)
            tp = sum(bool(d.run(load(p), stage2, noise)[1]) for p in wakes)
            print(f"noise={noise:3} stage2={stage2!s:5}  podcast false wakes={fp:3}  true wakes {tp}/{len(wakes)}")
    bgs = [load(p) for p in pods]
    for scale in (0.2, 0.35):
        tp = 0
        for k, p in enumerate(wakes):
            w = load(p); bg = bgs[(k + 3) % len(bgs)][RATE * 20:RATE * 20 + len(w) + RATE * 2]
            tp += bool(d.run(np.concatenate([w, np.zeros(RATE * 2)])[:len(bg)] + scale * bg)[1])
        print(f"wake over podcast x{scale}: {tp}/{len(wakes)}")
    if args.real:
        for p in sorted(glob.glob(os.path.join(args.real, "*.wav"))):
            ok, heard = d.verify(load(p))
            print(f"{'PASS  ' if ok else 'reject'} {os.path.basename(p)}: {heard}")


if __name__ == "__main__":
    main()
