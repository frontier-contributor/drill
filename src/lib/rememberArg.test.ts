import test from "node:test";
import assert from "node:assert/strict";
import { guessType, parseRememberArg, wrapUpWindow } from "@/lib/rememberArg";

test("the fact after the command is what gets saved", () => {
  const r = parseRememberArg("I prefer the intuition before the formula");
  assert.deepEqual(r, { scope: "project", type: "preference", text: "I prefer the intuition before the formula" });
});

test("nothing after the command is not a fact", () => {
  assert.equal(parseRememberArg(""), null);
  assert.equal(parseRememberArg("   "), null);
  assert.equal(parseRememberArg("that"), null);
});

test("'remember that…' keeps only the part being remembered", () => {
  assert.equal(parseRememberArg("that I work as a data engineer")?.text, "I work as a data engineer");
});

test("a global fact has to say so", () => {
  const r = parseRememberArg("global: I am a software engineer");
  assert.equal(r?.scope, "global");
  assert.equal(r?.type, "profile");
  assert.equal(r?.text, "I am a software engineer");
  assert.equal(parseRememberArg("Everywhere:  keep answers short")?.scope, "global");
});

test("the wording picks the type, in an order that resolves the overlaps", () => {
  const cases: [string, string][] = [
    ["See https://distill.pub/2016/momentum for the momentum picture", "reference"],
    ["I want to finish the transformer chapter by the end of October", "goal"],
    ["I'm trying to learn measure theory properly", "goal"],
    ["I don't understand why softmax needs the log-sum-exp trick", "open"],
    ["Why does batch norm help at inference?", "open"],
    ["Always write vectors as columns", "convention"],
    ["Use θ for parameters and φ for the variational ones", "convention"],
    ["I hate long answers", "preference"],
    ["I like to see the code before the maths", "preference"],
    ["I have a maths degree but never did probability", "profile"],
    ["Backprop is the chain rule applied from the output backwards", "understanding"]
  ];
  for (const [text, type] of cases) assert.equal(guessType(text), type, text);
});

test("a save reads forward from where the last one stopped, up to its budget", () => {
  assert.deepEqual(wrapUpWindow([10, 20, 30, 40], 0, 35), { end: 2, chars: 30 });
  assert.deepEqual(wrapUpWindow([10, 20, 30, 40], 2, 35), { end: 3, chars: 30 });
});

test("one enormous turn is read on its own rather than blocking every save after it", () => {
  assert.deepEqual(wrapUpWindow([100, 5], 0, 50), { end: 1, chars: 100 });
});

test("empty turns ride along without spending the budget", () => {
  assert.deepEqual(wrapUpWindow([0, 0, 60, 10], 0, 50), { end: 3, chars: 60 });
});

test("starting past the end reads nothing", () => {
  assert.deepEqual(wrapUpWindow([10, 10], 5, 50), { end: 2, chars: 0 });
});
