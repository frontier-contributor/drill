/* ============================================================================
 * capture.test.ts — reading back what another AI wrote.
 *
 * The bridge's whole value is that a session in another app turns into cards
 * without retyping, and the other app is not under our control: it wraps the
 * block in chatter, curls the quotes on the way through the clipboard, leaves
 * trailing commas, renames fields, or ignores the format and writes Q:/A:
 * pairs. Each of those used to be a reason to lose a session's cards, silently
 * — a parser that returns nothing looks exactly like a conversation that had
 * nothing in it. So each is held here.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { BridgeParseError, bridgePrompt, journalText, parseBridgeReply } from "@/lib/capture";

const FENCE = "```";

test("a drill block surrounded by chatter is found and read", () => {
  const reply = [
    "Great session! Here's your export:",
    "",
    FENCE + "drill",
    JSON.stringify({
      summary: "We covered precision and recall.",
      cards: [{ tag: "Metrics", q: "What does recall measure?", a: "The share of actual positives found." }],
      notes: ["Recall is about the positives you missed."],
      memories: [{ type: "understanding", text: "Thinks of recall as coverage." }],
      open: ["Why F1 and not the mean?"]
    }),
    FENCE,
    "Let me know if you want more cards!"
  ].join("\n");
  const r = parseBridgeReply(reply);
  assert.equal(r.summary, "We covered precision and recall.");
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].tag, "Metrics");
  assert.deepEqual(r.notes, ["Recall is about the positives you missed."]);
  assert.equal(r.memories[0].type, "understanding");
  assert.deepEqual(r.open, ["Why F1 and not the mean?"]);
  assert.deepEqual(r.problems, []);
});

test("clipboard damage — curly quotes and trailing commas — is repaired", () => {
  const reply = FENCE + "drill\n{“summary”: “Gradients.”, “cards”: [{“q”: “What is a gradient?”, “a”: “The vector of partials.”,},],}\n" + FENCE;
  const r = parseBridgeReply(reply);
  assert.equal(r.summary, "Gradients.");
  assert.equal(r.cards[0].a, "The vector of partials.");
});

test("curly quotes inside valid JSON are left alone", () => {
  const reply = JSON.stringify({ cards: [{ q: "What does “stable” mean in FSRS?", a: "How long a memory lasts." }] });
  assert.equal(parseBridgeReply(reply).cards[0].q, "What does “stable” mean in FSRS?");
});

test("renamed fields and bare arrays are read", () => {
  const r = parseBridgeReply(JSON.stringify({ flashcards: [{ question: "2+2?", answer: "4", topic: "Arithmetic" }], insights: [{ text: "Sums commute." }] }));
  assert.equal(r.cards[0].q, "2+2?");
  assert.equal(r.cards[0].tag, "Arithmetic");
  assert.deepEqual(r.notes, ["Sums commute."]);
  const arr = parseBridgeReply(FENCE + "json\n" + JSON.stringify([{ q: "a?", a: "b" }]) + "\n" + FENCE);
  assert.equal(arr.cards.length, 1);
});

test("a stray bracket in the prose does not hide the object after it", () => {
  const reply = 'Done [see below]: {"summary": "Eigenvectors.", "cards": [{"q": "Av = ?", "a": "λv"}]}';
  const r = parseBridgeReply(reply);
  assert.equal(r.summary, "Eigenvectors.");
  assert.equal(r.cards[0].a, "λv");
});

test("the format ignored entirely still yields its Q/A pairs, and says so", () => {
  const reply = "Here are some flashcards:\n\n1. Q: What is overfitting?\nA: Fitting noise in the training data.\n\n2. Q: What does dropout do?\nA: Randomly zeroes activations during training.";
  const r = parseBridgeReply(reply);
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards[1].a, "Randomly zeroes activations during training.");
  assert.equal(r.problems.length, 1);
});

test("what it drops, it reports", () => {
  const r = parseBridgeReply(JSON.stringify({ cards: [{ q: "no answer" }, { q: "ok?", a: "ok" }, "junk"] }));
  assert.equal(r.cards.length, 1);
  assert.match(r.problems[0], /2 cards were missing/);
});

test("unknown memory types fall back rather than being dropped", () => {
  const r = parseBridgeReply(JSON.stringify({ memories: [{ type: "fact", text: "x" }, "a bare string memory"] }));
  assert.deepEqual(
    r.memories.map((m) => m.type),
    ["understanding", "understanding"]
  );
});

test("nothing usable is an error with a sentence, not an empty import", () => {
  assert.throws(() => parseBridgeReply(""), BridgeParseError);
  assert.throws(() => parseBridgeReply("Sure! What would you like to study today?"), BridgeParseError);
  assert.throws(() => parseBridgeReply(FENCE + "drill\n{}\n" + FENCE), BridgeParseError);
});

test("the prompt carries the project and never an empty clause", () => {
  const p = bridgePrompt({ projectName: "ML", goals: "Implement from scratch.", gaps: [], tags: [] });
  assert.match(p, /"ML" — Implement from scratch\./);
  assert.ok(!p.includes("keep getting wrong"), "no gaps, no gap sentence");
  assert.ok(p.includes(FENCE + "drill"));
  const q = bridgePrompt({ projectName: "ML", goals: "", gaps: ["sign of the gradient"], tags: ["Backprop"] });
  assert.match(q, /sign of the gradient/);
  assert.match(q, /tagged Backprop/);
});

test("the journal record lists what was kept, not what was declined", () => {
  const r = parseBridgeReply(JSON.stringify({ summary: "S.", notes: ["a", "b"], open: ["o"], cards: [{ q: "q", a: "a" }] }));
  const t = journalText(r, ["b"], 1);
  assert.ok(t.includes("- b") && !t.includes("- a"));
  assert.ok(t.includes("Still open:\n- o"));
  assert.ok(t.includes("1 card proposed"));
});
