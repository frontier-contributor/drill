/* ============================================================================
 * turns.test.ts — when a turn ends is what a voice interface feels like.
 *
 * Every regression here is silent: nothing throws, the app just starts
 * talking over someone mid-thought, or sits in a dead second after every
 * question, or stops a reply because somebody coughed. So the timings are
 * replayed frame by frame, the way the microphone delivers them.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { TIMING, TurnTaker, looksComplete, type TurnEvent } from "@/lib/voice/turns";

const FRAME = 20;

/** Feed `ms` of speech or silence from time `t`, collecting every event. */
function run(tt: TurnTaker, plan: [boolean, number][], t0 = 0): { events: TurnEvent[]; at: number[]; t: number } {
  const events: TurnEvent[] = [];
  const at: number[] = [];
  let t = t0;
  for (const [speech, ms] of plan) {
    for (let d = 0; d < ms; d += FRAME) {
      for (const e of tt.frame(speech, t, FRAME)) {
        events.push(e);
        at.push(t);
      }
      t += FRAME;
    }
  }
  return { events, at, t };
}

const types = (es: TurnEvent[]) => es.map((e) => e.type);

test("a turn starts on voice, speculates at a short pause, and ends at the long one", () => {
  const tt = new TurnTaker(TIMING.balanced);
  const r = run(tt, [
    [true, 800],
    [false, 1500]
  ]);
  assert.deepEqual(types(r.events), ["start", "eager", "end"]);
  /* Words unknown: it waits the in-between time, not the shortest. */
  const end = r.at[2] - 800;
  assert.ok(end >= TIMING.balanced.unknown - FRAME && end <= TIMING.balanced.unknown + FRAME, `ended at ${end}ms`);
});

test("finished-sounding words end the turn sooner; a trailing 'and' holds it open", () => {
  const done = new TurnTaker(TIMING.balanced);
  run(done, [[true, 600]]);
  let t = 600;
  let ended = -1;
  for (; t < 3000 && ended < 0; t += FRAME) {
    if (t === 900) done.hint("What is a gradient?", t);
    if (done.frame(false, t, FRAME).some((e) => e.type === "end")) ended = t - 600;
  }
  assert.ok(ended > 0 && ended <= TIMING.balanced.complete + FRAME, `complete ended at ${ended}`);

  const open = new TurnTaker(TIMING.balanced);
  run(open, [[true, 600]]);
  ended = -1;
  for (t = 600; t < 4000 && ended < 0; t += FRAME) {
    if (t === 900) open.hint("so the thing I don't get is, and", t);
    if (open.frame(false, t, FRAME).some((e) => e.type === "end")) ended = t - 600;
  }
  assert.ok(ended >= TIMING.balanced.incomplete - FRAME, `unfinished ended too soon, at ${ended}`);
});

test("words that arrive after their own deadline end the turn at once", () => {
  const tt = new TurnTaker(TIMING.balanced);
  run(tt, [[true, 500]]);
  /* 700 ms of quiet: past `complete` (600), short of `unknown` (900). */
  run(tt, [[false, 700]], 500);
  const out = tt.hint("Explain backprop.", 1200);
  assert.deepEqual(types(out), ["end"]);
});

test("speaking again after the eager pause throws the speculation away", () => {
  const tt = new TurnTaker(TIMING.balanced);
  const r = run(tt, [
    [true, 500],
    [false, 300],
    [true, 400],
    [false, 1500]
  ]);
  assert.deepEqual(types(r.events), ["start", "eager", "resume", "eager", "end"]);
});

test("holding the floor: no pause ends the turn, letting go ends it at once", () => {
  const tt = new TurnTaker(TIMING.quick);
  tt.lock(true);
  const r = run(tt, [
    [true, 400],
    [false, 5000]
  ]);
  assert.deepEqual(types(r.events), ["start"]);
  assert.deepEqual(types(tt.lock(false)), ["end"]);
});

test("a click or a cough is not a turn", () => {
  const tt = new TurnTaker(TIMING.balanced);
  const blip = run(tt, [
    [true, 40],
    [false, 1500]
  ]);
  assert.deepEqual(types(blip.events), []);

  /* Long enough to start, too short to have been words. */
  const cough = run(tt, [
    [true, 120],
    [false, 1500]
  ], blip.t);
  assert.deepEqual(types(cough.events), ["start", "eager", "discard"]);
});

test("talking over a reply takes longer than starting a turn, and longer again without echo cancellation", () => {
  const full = new TurnTaker(TIMING.balanced);
  full.replyPlaying("full");
  assert.deepEqual(types(run(full, [[true, 200]]).events), [], "200 ms is not an interruption");
  const f = run(full, [[true, 200]], 200);
  assert.deepEqual(types(f.events), ["barge"]);

  const half = new TurnTaker(TIMING.balanced);
  half.replyPlaying("half");
  assert.deepEqual(types(run(half, [[true, 400]]).events), []);
  assert.deepEqual(types(run(half, [[true, 200]], 400).events), ["barge"]);
});

test("a murmur under a reply that never reaches the bar is forgotten, not saved up", () => {
  const tt = new TurnTaker(TIMING.balanced);
  tt.replyPlaying("full");
  /* Three short bursts with long gaps: each is cleared before the next. */
  const r = run(tt, [
    [true, 200],
    [false, 500],
    [true, 200],
    [false, 500],
    [true, 200],
    [false, 500]
  ]);
  assert.deepEqual(types(r.events), []);
});

test("what counts as finished", () => {
  assert.equal(looksComplete("What's a gradient?"), true);
  assert.equal(looksComplete("tell me about attention"), true);
  assert.equal(looksComplete("and then the second thing is"), false);
  assert.equal(looksComplete("I was thinking, um"), false);
  assert.equal(looksComplete("the first part,"), false);
  assert.equal(looksComplete("so."), false);
  assert.equal(looksComplete(""), false);
});
