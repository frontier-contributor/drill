/* ============================================================================
 * structured.test.ts — the one recovery, and every failure it must not touch.
 *
 * `chat` is a script, the same bargain agent/loop.test.ts makes: no API key,
 * no IndexedDB, no catalogue, and the control flow is still held to account.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { ReplyCutOff } from "@/lib/budget";
import { makeStructured, type StructuredChat, type StructuredEnv } from "@/services/ai/structured";
import type { ChatOpts, FinishInfo } from "@/types";

type Step = { text: string; finish?: FinishInfo } | { error: unknown };

function scripted(steps: Step[]) {
  const calls: ChatOpts[] = [];
  const chat: StructuredChat<undefined> = async (_messages, opts) => {
    calls.push(opts);
    const step = steps[calls.length - 1];
    if (!step) throw new Error("an extra request nobody scripted");
    if ("error" in step) throw step.error;
    if (step.finish) opts.onFinish?.(step.finish);
    return step.text;
  };
  return { chat, calls };
}

const reasoner = (): StructuredEnv => ({ backend: "openrouter", model: "vendor/reasoner-1", verdict: "yes" });

const request = () => ({
  messages: [{ role: "user" as const, content: "roll up the week" }],
  label: "rollup",
  what: "weekly rollup",
  answerTokens: 2400,
  parse: (text: string) => JSON.parse(text) as { ok: boolean }
});

const done: FinishInfo = { reason: "stop", reasoned: false, partial: false };

test("a reply that fits is parsed, once", async () => {
  const { chat, calls } = scripted([{ text: '{"ok":true}', finish: done }]);
  const out = await makeStructured(chat, reasoner)(request());
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, "rollup");
  assert.equal(calls[0].maxTokens, 7200);
  assert.equal(calls[0].reasoning, undefined);
});

test("a reply cut off while thinking is retried once, with more room, and says so on the transcript", async () => {
  const { chat, calls } = scripted([
    { error: new ReplyCutOff("hit the cap", "length", true) },
    { text: '{"ok":true}', finish: done }
  ]);
  const out = await makeStructured(chat, reasoner)(request());
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].label, "rollup · retry");
  assert.ok((calls[1].maxTokens || 0) > (calls[0].maxTokens || 0));
  assert.deepEqual(calls[1].reasoning, { effort: "low" });
});

test("JSON that stops half way counts as running out of room", async () => {
  const { chat, calls } = scripted([
    { text: '{"ok":', finish: { reason: "length", reasoned: false, partial: true } },
    { text: '{"ok":true}', finish: done }
  ]);
  assert.deepEqual(await makeStructured(chat, reasoner)(request()), { ok: true });
  assert.equal(calls.length, 2);
  /* No evidence of reasoning, so the retry must not send a reasoning control —
     on a hybrid model that would switch thinking on. */
  assert.equal(calls[1].reasoning, undefined);
});

test("a scratchpad left in the text is evidence of reasoning", async () => {
  const { chat, calls } = scripted([
    { text: "<think>let me consider every entry in turn", finish: { reason: "length", reasoned: false, partial: true } },
    { text: '{"ok":true}', finish: done }
  ]);
  await makeStructured(chat, reasoner)(request());
  assert.deepEqual(calls[1].reasoning, { effort: "low" });
});

test("a complete reply that will not parse is not retried — more room would not change it", async () => {
  const { chat, calls } = scripted([{ text: "Here is your summary, in prose.", finish: done }]);
  await assert.rejects(makeStructured(chat, reasoner)(request()), SyntaxError);
  assert.equal(calls.length, 1);
});

test("any other failure passes straight through, untouched", async () => {
  const key = new Error("OpenRouter rejected the key (401)");
  const { chat, calls } = scripted([{ error: key }]);
  await assert.rejects(makeStructured(chat, reasoner)(request()), (e) => e === key);
  assert.equal(calls.length, 1);
});

test("a stop is a stop", async () => {
  const abort = new DOMException("Aborted", "AbortError");
  const { chat, calls } = scripted([{ error: abort }]);
  await assert.rejects(makeStructured(chat, reasoner)(request()), (e) => e === abort);
  assert.equal(calls.length, 1);
});

test("running out twice gives up with a sentence that names what was tried and what to change", async () => {
  const { chat, calls } = scripted([
    { error: new ReplyCutOff("cap", "length", true) },
    { error: new ReplyCutOff("cap", "length", true) }
  ]);
  await assert.rejects(makeStructured(chat, reasoner)(request()), (e: Error) => {
    assert.match(e.message, /weekly rollup ran out of room twice/);
    assert.match(e.message, /7,200 tokens, then 14,400 tokens, thinking turned down to low/);
    assert.match(e.message, /reasoner-1 spent the budget thinking/);
    assert.doesNotMatch(e.message, /vendor\//);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("a retry that would send the same request is not sent", async () => {
  /* Groq gets no reasoning dial, and a model already at its output limit cannot
     be given more room — so the second request would be the first one again. */
  const capped = (): StructuredEnv => ({ backend: "groq", model: "qwen-qwq", verdict: "unknown", maxOutput: 2400 });
  const { chat, calls } = scripted([{ error: new ReplyCutOff("cap", "length", true) }]);
  await assert.rejects(makeStructured(chat, capped)(request()), (e: Error) => {
    assert.match(e.message, /ran out of room \(2,400 tokens\)/);
    assert.doesNotMatch(e.message, /twice/);
    return true;
  });
  assert.equal(calls.length, 1);
});
