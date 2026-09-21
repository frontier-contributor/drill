/* ============================================================================
 * reasoning.test.ts — the cap is the only thing bounding a reasoning record.
 *
 * A conversation is one IndexedDB record rewritten whole on every message, so
 * an uncapped chain is not just a big field: it is a big field re-serialised on
 * every subsequent send, against a quota that this app has already overrun
 * once. The invariant worth a test is the cheap one to get wrong — the elision
 * marker must count *against* the budget rather than being added on top of it,
 * which is how a "cap" quietly stops capping.
 *
 * The rest of this module is phrasing and is checked by looking at it.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { REASONING_CAP, capReasoning, thoughtLabel } from "@/lib/reasoning";

/** Realistic shape: words and newlines, so the whitespace back-up has
 *  somewhere to land. */
function chain(chars: number): string {
  let s = "";
  let i = 0;
  while (s.length < chars) s += `step ${i++} of the working here\n`;
  return s.slice(0, chars);
}

test("a chain under the cap is kept whole and unmarked", () => {
  const c = capReasoning("thinking about it");
  assert.equal(c.text, "thinking about it");
  assert.equal(c.clipped, false);
});

test("a capped chain never exceeds the cap, marker included", () => {
  for (const n of [REASONING_CAP + 1, REASONING_CAP * 2, 100_000]) {
    const c = capReasoning(chain(n));
    assert.ok(c.text.length <= REASONING_CAP, `${n} chars capped to ${c.text.length}`);
    assert.equal(c.clipped, true);
  }
});

test("both ends survive — the conclusion is the half that explains the answer", () => {
  const raw = "OPENING MOVE\n" + chain(40_000) + "\nFINAL CONCLUSION";
  const c = capReasoning(raw);
  assert.ok(c.text.startsWith("OPENING MOVE"), "kept the framing");
  assert.ok(c.text.endsWith("FINAL CONCLUSION"), "kept the conclusion");
  assert.ok(c.text.includes("elided"), "said that the middle went");
});

test("a cap too small for the marker still caps", () => {
  const c = capReasoning(chain(5000), 50);
  assert.ok(c.text.length <= 50);
  assert.equal(c.clipped, true);
});

test("a duration with no token count is still worth saying", () => {
  assert.equal(thoughtLabel(4200), "Thought for 4.2s");
  assert.equal(thoughtLabel(4200, 1400), "Thought for 4.2s · 1.4k tokens");
  assert.equal(thoughtLabel(undefined, 0), "Thought before answering");
  assert.equal(thoughtLabel(900), "Thought for a moment");
  assert.equal(thoughtLabel(125_000), "Thought for 2m 5s");
});
