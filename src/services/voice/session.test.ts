/* ============================================================================
 * session.test.ts — a whole voice conversation, with no microphone.
 *
 * The session is where an interface like this goes wrong in ways nobody can
 * see: a reply stopped by its own echo, an interruption that leaves words in
 * the history nobody heard, a phantom "thank you" answered out loud, a call
 * that gets stuck thinking. Every part is a fake here — capture, ears, voice,
 * and the chat itself — so each of those can be played out frame by frame.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceSession, type Brain, type MouthLike, type SessionDeps } from "@/services/voice/session";
import type { Capture, CaptureFrame } from "@/services/voice/capture";
import type { Ears } from "@/services/voice/ears";
import type { MouthHooks } from "@/services/voice/mouth";
import type { SpokenChunk } from "@/lib/voice/chunker";
import type { VoiceTurn } from "@/context/ChatContext";
import type { TalkSettings } from "@/types";

const flush = () => new Promise((r) => setTimeout(r, 0));

class FakeCapture implements Capture {
  echoCancelled = true;
  private fn: ((f: CaptureFrame) => void) | null = null;
  private t = 0;
  recording = false;
  margin = 12;
  onFrame(fn: (f: CaptureFrame) => void) {
    this.fn = fn;
  }
  begin() {
    this.recording = true;
  }
  snapshot() {
    return this.recording ? { wav: new Blob(["x"]), seconds: 1 } : null;
  }
  end() {
    this.recording = false;
  }
  setMuted() {}
  setMargin(db: number) {
    this.margin = db;
  }
  now() {
    return this.t;
  }
  close() {
    this.fn = null;
  }
  /** Feed `ms` of voice or silence. */
  feed(speech: boolean, ms: number) {
    for (let d = 0; d < ms; d += 20) {
      this.fn?.({ speech, level: speech ? 0.8 : 0, t: this.t, ms: 20 });
      this.t += 20;
    }
  }
}

class FakeMouth implements MouthLike {
  cancellable = true;
  label = "fake voice";
  queue: SpokenChunk[] = [];
  said: string[] = [];
  playing: SpokenChunk | null = null;
  paused = false;
  replyEnded = true;
  released = false;
  constructor(private hooks: MouthHooks) {}
  get speaking() {
    return !!this.playing && !this.paused;
  }
  get busy() {
    return !!this.playing || this.queue.length > 0 || !this.replyEnded;
  }
  get current() {
    return this.playing;
  }
  begin() {
    this.replyEnded = false;
  }
  say(c: SpokenChunk) {
    this.queue.push(c);
    if (!this.playing && !this.paused) this.next();
  }
  end() {
    this.replyEnded = true;
    if (!this.playing && !this.queue.length) this.hooks.drained();
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  stop() {
    const was = this.playing;
    this.queue = [];
    this.playing = null;
    this.replyEnded = true;
    return was;
  }
  level() {
    return 0;
  }
  release() {
    this.released = true;
  }
  /** The clip playing now finishes. */
  finish() {
    this.playing = null;
    if (this.queue.length) this.next();
    else if (this.replyEnded) this.hooks.drained();
  }
  private next() {
    this.playing = this.queue.shift()!;
    this.said.push(this.playing.text);
    this.hooks.started(this.playing);
  }
}

class FakeBrain implements Brain {
  asked: string[] = [];
  cuts: [string, string][] = [];
  stops = 0;
  turn: VoiceTurn | null = null;
  n = 0;
  ask(text: string, voice: VoiceTurn) {
    this.asked.push(text);
    this.turn = voice;
    voice.onStart("turn-" + ++this.n);
    return Promise.resolve();
  }
  cut(id: string, text: string) {
    this.cuts.push([id, text]);
  }
  stop() {
    this.stops++;
  }
}

const TALK: TalkSettings = { ears: "", hearModels: {}, sensitivity: "balanced", bargeIn: true, style: "talk", model: "" };

function rig(heardQueue: string[]) {
  const capture = new FakeCapture();
  let mouth: FakeMouth | null = null;
  const brain = new FakeBrain();
  const ears: Ears = {
    id: "groq",
    label: "fake ears",
    transcribe: () => Promise.resolve(heardQueue.shift() ?? ""),
    close() {}
  };
  const deps: SessionDeps = {
    prepare(hooks) {
      mouth = new FakeMouth(hooks);
      return mouth;
    },
    openCapture: () => Promise.resolve(capture),
    openEars: () => ears,
    talk: () => TALK,
    now: () => capture.now(),
    teardown() {}
  };
  const session = createVoiceSession(deps);
  return { session, capture, brain, mouth: () => mouth!, ears };
}

/** Say something and pause long enough for the turn to end. */
async function speak(capture: FakeCapture, ms = 700) {
  capture.feed(true, ms);
  capture.feed(false, 400);
  await flush();
  capture.feed(false, 1200);
  await flush();
  await flush();
}

test("a question is heard, answered, spoken, and the call goes back to listening", async () => {
  const r = rig(["What is a gradient?"]);
  await r.session.start(r.brain, "talk");
  assert.equal(r.session.get().phase, "listening");

  await speak(r.capture);
  assert.deepEqual(r.brain.asked, ["What is a gradient?"]);
  assert.equal(r.session.get().phase, "thinking");

  r.brain.turn!.onText("It points uphill. ");
  assert.equal(r.session.get().phase, "speaking");
  r.brain.turn!.onText("It points uphill. Descent goes the other way.");
  r.brain.turn!.onDone({ ok: true });
  r.mouth().finish();
  r.mouth().finish();
  assert.deepEqual(r.mouth().said, ["It points uphill.", "Descent goes the other way."]);
  assert.equal(r.session.get().phase, "listening");
});

test("talking over it: the reply pauses at once, then is cut back to what was heard", async () => {
  const r = rig(["Explain backprop.", "wait, what does that mean"]);
  await r.session.start(r.brain, "talk");
  await speak(r.capture);
  const reply = "First, the loss. Then the gradient flows back. Then the weights move.";
  r.brain.turn!.onText(reply);
  assert.deepEqual(r.mouth().said, ["First, the loss."]);

  /* 400 ms of voice over the reply: past the 300 ms bar. */
  r.capture.feed(true, 400);
  assert.equal(r.mouth().paused, true, "paused the moment it was talked over");
  r.capture.feed(false, 1500);
  await flush();
  await flush();

  assert.equal(r.brain.cuts.length, 1);
  const [id, kept] = r.brain.cuts[0];
  assert.equal(id, "turn-1");
  assert.match(kept, /^First, the loss\./);
  assert.ok(!kept.includes("weights"), "nothing after what was heard stays in the history");
  assert.equal(r.brain.stops, 1, "the reply still being written is stopped");
  assert.deepEqual(r.brain.asked, ["Explain backprop.", "wait, what does that mean"]);
});

test("its own voice leaking into the microphone does not stop it", async () => {
  const r = rig(["Tell me about attention.", "queries keys and values are compared"]);
  await r.session.start(r.brain, "talk");
  await speak(r.capture);
  r.brain.turn!.onText("In attention, queries keys and values are compared to decide what matters. ");

  r.capture.feed(true, 400);
  r.capture.feed(false, 1500);
  await flush();
  await flush();

  assert.equal(r.mouth().paused, false, "resumed");
  assert.equal(r.brain.cuts.length, 0);
  assert.deepEqual(r.brain.asked, ["Tell me about attention."]);
});

test("a phantom from a blip of noise is not answered", async () => {
  const r = rig(["Thank you."]);
  await r.session.start(r.brain, "talk");
  /* 260 ms of "voice": past the turn's own floor, short of a spoken thank-you. */
  await speak(r.capture, 260);
  assert.deepEqual(r.brain.asked, []);
  assert.equal(r.session.get().phase, "listening");
});

test("holding the floor: a long pause does not end the turn; letting go does", async () => {
  const r = rig(["Let me think about how to put this."]);
  await r.session.start(r.brain, "talk");
  r.session.setLocked(true);
  await speak(r.capture);
  r.capture.feed(false, 4000);
  await flush();
  assert.deepEqual(r.brain.asked, []);
  r.session.setLocked(false);
  await flush();
  await flush();
  assert.deepEqual(r.brain.asked, ["Let me think about how to put this."]);
});

test("ending the call mid-reply stops the voice but not the answer", async () => {
  const r = rig(["Summarise my week."]);
  await r.session.start(r.brain, "talk");
  await speak(r.capture);
  const turn = r.brain.turn!;
  turn.onText("You reviewed forty cards. ");
  const mouth = r.mouth();
  r.session.stop();
  assert.equal(r.session.get().phase, "off");
  assert.equal(mouth.released, true);
  assert.equal(r.brain.stops, 0, "the reply keeps being written into the thread");
  /* Late text from that reply reaches nothing. */
  turn.onText("You reviewed forty cards. Most were easy.");
  assert.deepEqual(mouth.said, ["You reviewed forty cards."]);
});

test("a lookup gets one line said while it runs, and the call stays thinking", async () => {
  const r = rig(["What did I miss on Tuesday?"]);
  await r.session.start(r.brain, "talk");
  await speak(r.capture);
  r.brain.turn!.onStatus({ kind: "tool", name: "reviews", label: "Checking your reviews" });
  r.brain.turn!.onStatus({ kind: "tool", name: "recall", label: "Searching your record" });
  assert.deepEqual(r.mouth().said, ["Checking your reviews…"]);
  assert.equal(r.session.get().phase, "thinking");
  assert.equal(r.session.get().status, "Searching your record…");
});
