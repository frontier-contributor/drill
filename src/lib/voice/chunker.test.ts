/* ============================================================================
 * chunker.test.ts — what a streaming reply sounds like.
 *
 * The failures this guards are the ones a listener notices and a test runner
 * never would: a sentence said twice because the text grew, a code block read
 * out bracket by bracket, a tool call spoken aloud, an interrupted reply saved
 * with words nobody heard.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { Chunker, cutReply, type SpokenChunk } from "@/lib/voice/chunker";

/** Stream `text` in `step`-character slices, as tokens arrive. */
function stream(text: string, step = 3): SpokenChunk[] {
  const c = new Chunker();
  const out: SpokenChunk[] = [];
  for (let i = step; i < text.length + step; i += step) out.push(...c.push(text.slice(0, i)));
  out.push(...c.finish());
  return out;
}

const said = (cs: SpokenChunk[]) => cs.map((c) => c.text);

test("sentences come out once each, in order, however the text arrives", () => {
  const text = "A gradient points uphill. Descent walks the other way. That is the whole idea!";
  for (const step of [1, 2, 5, 17, 200]) {
    assert.deepEqual(
      said(stream(text, step)),
      ["A gradient points uphill.", "Descent walks the other way.", "That is the whole idea!"],
      `step ${step}`
    );
  }
});

test("the first thing said can be a clause, so the voice starts sooner", () => {
  const c = new Chunker();
  const first = c.push("Sure, so the short version is that a learning rate, set too high");
  assert.equal(first.length, 1);
  assert.match(first[0].text, /learning rate,$/);
  /* Nothing of it is said again when the sentence finishes. */
  const rest = [...c.push("Sure, so the short version is that a learning rate, set too high, overshoots. "), ...c.finish()];
  assert.deepEqual(said(rest), ["set too high, overshoots."]);
});

test("code is never read — one line says where it went", () => {
  const reply = "Here it is.\n\n```python\nfor x in range(3):\n    print(x)\n```\n\nRun it and see.";
  const out = said(stream(reply, 4));
  assert.deepEqual(out, ["Here it is.", "I've put the Python code on screen.", "Run it and see."]);
  assert.ok(!out.join(" ").includes("print"));
});

test("figures are named from the catalogue, tables once, and the app's own blocks not at all", () => {
  const reply = [
    "Look at this.",
    "",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```drill-call",
    '{"name":"recall"}',
    "```",
    "Done."
  ].join("\n");
  assert.deepEqual(said(stream(reply, 6)), ["Look at this.", "I've put a diagram on screen.", "I've put a table on screen.", "Done."]);
});

test("headings and list items end where their lines do", () => {
  const reply = "## Three steps\n- Compute the loss\n- Take the gradient\n- Step downhill\n";
  assert.deepEqual(said(stream(reply, 5)), ["Three steps.", "Compute the loss.", "Take the gradient.", "Step downhill."]);
});

test("maths is said in words, and markdown is not said at all", () => {
  const out = said(stream("The loss is $\\frac{1}{2m}$ times the **sum** of [squared errors](https://x.y). ", 4)).join(" ");
  assert.match(out, /1 over 2 m/);
  assert.ok(!/[*$[\]]|https/.test(out), out);
});

test("text thrown away mid-stream starts a new run — nothing from before is replayed", () => {
  const c = new Chunker();
  const a = c.push("Let me check your reviews. ");
  assert.deepEqual(said(a), ["Let me check your reviews."]);
  /* The agent loop clears what it streamed when it calls a tool. */
  const b = [...c.push("You missed three cards on Tuesday. "), ...c.finish()];
  assert.deepEqual(said(b), ["You missed three cards on Tuesday."]);
  assert.ok(b[0].gen > a[0].gen);
});

test("an interrupted reply is cut after what was said, never inside a code block", () => {
  const reply = "First point. Second point.\n\n```js\nconst a = 1;\n```\n\nThird point.";
  const chunks = stream(reply, 5);
  const second = chunks.find((c) => c.text === "Second point.")!;
  const cut = cutReply(reply, second.rawEnd);
  assert.match(cut, /^First point\. Second point\./);
  assert.ok(!cut.includes("Third"), cut);
  assert.ok(cut.endsWith("…"));

  /* Cut while the block was being named: the block stays whole. */
  const cue = chunks.find((c) => c.cue)!;
  const whole = cutReply(reply, cue.rawEnd);
  assert.ok(whole.includes("const a = 1;\n```"), whole);
  assert.ok(!whole.includes("Third"));
});
