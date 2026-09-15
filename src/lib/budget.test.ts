/* ============================================================================
 * budget.test.ts — how much room a one-shot call gets, and the one thing the
 * retry must never do: turn reasoning on for a model that was not using it.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { ReplyCutOff, describePlan, planBudget, samePlan } from "@/lib/budget";

test("a model known to think gets room to think on the first try", () => {
  const p = planBudget({ answerTokens: 2400, verdict: "yes", backend: "openrouter", attempt: 1 });
  assert.equal(p.maxTokens, 7200);
});

test("the first try never touches reasoning, whatever the model", () => {
  /* On a hybrid model that does not think by default, sending a reasoning
     control turns thinking on. The first try has no evidence either way. */
  for (const verdict of ["yes", "no", "unknown"] as const) {
    for (const backend of ["openrouter", "ollama", "groq", "custom"] as const) {
      const p = planBudget({ answerTokens: 1200, verdict, backend, attempt: 1 });
      assert.equal(p.reasoning, undefined, `${verdict}/${backend} sent reasoning`);
      assert.equal(p.think, undefined, `${verdict}/${backend} sent think`);
    }
  }
});

test("a model the catalogue says cannot think gets exactly what the call asked for", () => {
  assert.equal(planBudget({ answerTokens: 2400, verdict: "no", backend: "openrouter", attempt: 1 }).maxTokens, 2400);
});

test("not knowing gives modest room, and caps it", () => {
  assert.equal(planBudget({ answerTokens: 2400, verdict: "unknown", backend: "groq", attempt: 1 }).maxTokens, 4800);
  assert.equal(planBudget({ answerTokens: 6000, verdict: "unknown", backend: "groq", attempt: 1 }).maxTokens, 8192);
});

test("the model's own output limit wins over the room it would otherwise get", () => {
  const p = planBudget({ answerTokens: 2400, verdict: "yes", backend: "openrouter", maxOutput: 4000, attempt: 1 });
  assert.equal(p.maxTokens, 4000);
});

test("never below the answer — unless the model cannot write that much at all", () => {
  assert.equal(planBudget({ answerTokens: 512, verdict: "no", backend: "openrouter", maxOutput: 8000, attempt: 1 }).maxTokens, 512);
  assert.equal(planBudget({ answerTokens: 512, verdict: "unknown", backend: "custom", maxOutput: 300, attempt: 1 }).maxTokens, 300);
});

test("the retry doubles the room", () => {
  assert.equal(planBudget({ answerTokens: 2400, verdict: "yes", backend: "openrouter", attempt: 2 }).maxTokens, 14400);
  assert.equal(planBudget({ answerTokens: 2400, verdict: "no", backend: "openrouter", attempt: 2 }).maxTokens, 4800);
  assert.equal(planBudget({ answerTokens: 6000, verdict: "unknown", backend: "groq", attempt: 2 }).maxTokens, 16384);
});

test("the retry turns reasoning down only when the first reply reasoned", () => {
  const quiet = planBudget({ answerTokens: 2400, verdict: "yes", backend: "openrouter", attempt: 2, sawReasoning: false });
  assert.equal(quiet.reasoning, undefined);

  const openrouter = planBudget({ answerTokens: 2400, verdict: "yes", backend: "openrouter", attempt: 2, sawReasoning: true });
  assert.deepEqual(openrouter.reasoning, { effort: "low" });
  assert.equal(openrouter.think, undefined);

  const ollama = planBudget({ answerTokens: 2400, verdict: "unknown", backend: "ollama", attempt: 2, sawReasoning: true });
  assert.equal(ollama.think, false);
  assert.equal(ollama.reasoning, undefined);

  /* Groq 400s on a reasoning parameter for a model that has none, and the
     custom backend has no known dialect: room only. */
  for (const backend of ["groq", "custom"] as const) {
    const p = planBudget({ answerTokens: 2400, verdict: "unknown", backend, attempt: 2, sawReasoning: true });
    assert.equal(p.reasoning, undefined);
    assert.equal(p.think, undefined);
  }
});

test("a retry that would change nothing is recognisable", () => {
  const input = { answerTokens: 2400, verdict: "yes" as const, backend: "groq" as const, maxOutput: 4000 };
  const first = planBudget({ ...input, attempt: 1 });
  const second = planBudget({ ...input, attempt: 2, sawReasoning: true });
  assert.equal(samePlan(first, second), true);

  const or = { ...input, backend: "openrouter" as const };
  assert.equal(samePlan(planBudget({ ...or, attempt: 1 }), planBudget({ ...or, attempt: 2, sawReasoning: true })), false);
});

test("a plan describes itself in plain words", () => {
  assert.equal(describePlan({ maxTokens: 7200 }), "7,200 tokens");
  assert.equal(describePlan({ maxTokens: 14400, reasoning: { effort: "low" } }), "14,400 tokens, thinking turned down to low");
  assert.equal(describePlan({ maxTokens: 900, think: false }), "900 tokens, thinking off");
});

test("a cut-off reply is an Error that says why it was cut off", () => {
  const e = new ReplyCutOff("ran out", "length", true);
  assert.ok(e instanceof Error);
  assert.ok(e instanceof ReplyCutOff);
  assert.equal(e.finish, "length");
  assert.equal(e.reasoned, true);
});
