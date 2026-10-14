/* ============================================================================
 * loop.test.ts — the agent loop's control flow, against a scripted model.
 *
 * There is no API key in this environment, so the loop is driven by a fake
 * `chat` that replays a list of canned replies and records what it was sent.
 * That covers every branch that actually goes wrong in an agent loop —
 * stopping, budgets, batching, malformed calls, aborts, both protocols — and
 * it covers none of real streaming, real token accounting, or whether a real
 * model chooses good tools. Those need a key and a browser.
 *
 * Pure: no DOM, no IndexedDB. `runTool` is injected for exactly that reason.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { runAgent, type ChatFn, type RunToolFn } from "@/services/agent/loop";
import { parseTextCalls, textProtocolRules } from "@/services/agent/protocol";
import type { ChatMessage, ChatOpts } from "@/types";
import type { Tool, ToolContext, ToolResult } from "@/types/agent";

/* The loop builds the scratch itself, so callers hand it everything else. */
const CTX: Omit<ToolContext, "scratch"> = { projectId: "p1", conversationId: "c1", turnId: "t1" };

const TOOLS: Tool[] = [
  {
    name: "memory_search",
    description: "search memory",
    scope: "global",
    kind: "read",
    schema: { properties: { query: { type: "string", description: "what to look for" } }, required: ["query"] },
    run: () => ({ ok: true, text: "nothing" })
  },
  {
    name: "memory_write",
    description: "write memory",
    scope: "global",
    kind: "write",
    schema: { properties: { text: { type: "string", description: "the fact" } }, required: ["text"] },
    run: () => ({ ok: true, text: "saved" })
  }
];

/** A model that says whatever the script says next, and remembers what it was
 *  asked. `sent` is the assertion surface for "did the loop actually feed the
 *  result back". */
function scripted(replies: (string | { text: string; calls: { name: string; args?: Record<string, unknown> }[] })[]) {
  const sent: ChatMessage[][] = [];
  const opts: ChatOpts[] = [];
  let i = 0;
  const chat: ChatFn = async (messages, o) => {
    sent.push(messages.map((m) => ({ ...m })));
    opts.push(o);
    const r = replies[Math.min(i++, replies.length - 1)];
    /* Streams in both branches, because the real adapter does: a round that
       ends in tool calls still streams whatever prose came before them. */
    const text = typeof r === "string" ? r : r.text;
    o.onToken?.(text, text);
    if (typeof r !== "string") {
      o.onToolCalls?.(r.calls.map((c, n) => ({ id: `call${n}`, name: c.name, args: c.args || {} })));
    }
    return text;
  };
  return { chat, sent, opts, calls: () => i };
}

function runner(impl?: (name: string, args: Record<string, unknown>) => ToolResult): { fn: RunToolFn; seen: string[] } {
  const seen: string[] = [];
  const fn: RunToolFn = async (name, args) => {
    seen.push(name);
    return impl ? impl(name, args) : { ok: true, text: `result of ${name}` };
  };
  return { fn, seen };
}

function base(over: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const model = scripted(["done"]);
  const tools = runner();
  return {
    system: "You are a tutor.",
    history: [{ role: "user" as const, content: "hello" }],
    tools: TOOLS,
    protocol: "native" as const,
    ctx: CTX,
    maxSteps: 3,
    allowWrites: true,
    chat: model.chat,
    runTool: tools.fn,
    ...over
  };
}

function marked(name: string, flags: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    scope: "global",
    kind: "read",
    schema: {
      properties: {
        query: { type: "string", description: "q" },
        goal: { type: "string", description: "g" },
        steps: { type: "string", description: "s" },
        id: { type: "string", description: "i" },
        note: { type: "string", description: "n" },
        text: { type: "string", description: "t" },
        status: { type: "string", description: "st" },
        limit: { type: "number", description: "l" }
      },
      required: []
    },
    run: () => ({ ok: true, text: "" }),
    ...flags
  };
}

/** Plan tools the Deep tests actually call. The loop refuses any name that
 *  was not offered, so a plan the prompt mentions and the catalogue omits
 *  never runs — which is the point of the gate, and why these tests pass
 *  the tools in. */
function withPlan(tools: Tool[] = TOOLS): Tool[] {
  return [...tools, marked("plan", { opensPlan: true }), marked("plan_step", { closesPlan: true }), marked("note", { keepsNote: true })];
}

/* --------------------------------------------------------------- stopping */

test("a reply with no tool calls is the answer, and costs one request", async () => {
  const model = scripted(["Backprop is the chain rule, applied backwards."]);
  const tools = runner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn }));

  assert.equal(r.answer, "Backprop is the chain rule, applied backwards.");
  assert.equal(r.trace.steps.length, 0, "no tool steps were taken");
  assert.equal(model.calls(), 1, "exactly one request");
  assert.deepEqual(tools.seen, []);
});

test("a model that ignores the tools array degrades to a single call", async () => {
  /* The native path's most important failure mode: a model behind OpenRouter
     that has no tool support just answers. That must be a normal reply, not an
     error and not an empty loop. */
  const model = scripted(["I cannot use tools but here is an answer."]);
  const r = await runAgent(base({ chat: model.chat }));
  assert.match(r.answer, /here is an answer/);
  assert.equal(r.trace.truncated, false);
});

test("tool results are fed back and the second reply is the answer", async () => {
  const model = scripted([{ text: "let me check", calls: [{ name: "memory_search", args: { query: "backprop" } }] }, "You keep missing the ordering."]);
  const tools = runner(() => ({ ok: true, text: "they confuse the ordering" }));
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn }));

  assert.equal(r.answer, "You keep missing the ordering.");
  assert.equal(r.trace.steps.length, 1);
  assert.equal(r.trace.steps[0].thought, "let me check");
  assert.deepEqual(tools.seen, ["memory_search"]);

  /* The second request must actually carry the result, or the model is
     answering from nothing while looking like it looked something up. */
  const second = model.sent[1];
  const toolMsg = second.find((m) => m.role === "tool");
  assert.ok(toolMsg, "a tool message was sent back");
  assert.match(toolMsg!.content, /confuse the ordering/);
  assert.equal(toolMsg!.toolCallId, "call0");
});

/* ---------------------------------------------------------------- budgets */

test("the step ceiling is enforced and the last round asks for prose only", async () => {
  /* A model that would loop forever. maxSteps 2 means: two tool rounds, then
     a third request with no tools at all. The queries differ on purpose: an
     identical read is refused by the harness, and this test is about the
     ceiling, not about that refusal. */
  const model = scripted([
    { text: "step one", calls: [{ name: "memory_search", args: { query: "one" } }] },
    { text: "step two", calls: [{ name: "memory_search", args: { query: "two" } }] },
    { text: "step three", calls: [{ name: "memory_search", args: { query: "three" } }] },
    "forced answer"
  ]);
  const tools = runner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, maxSteps: 2 }));

  assert.equal(r.trace.steps.length, 2, "exactly two tool rounds ran");
  assert.equal(tools.seen.length, 2);
  assert.equal(r.trace.truncated, true, "flagged as cut short");
  assert.equal(r.answer, "step three", "the final request's prose is the answer");

  /* The forced round must not offer tools — a reply that is only a tool call
     could not answer anyone, and the learner already waited for it. */
  const finalOpts = model.opts[2];
  assert.equal(finalOpts.tools, undefined, "no tools on the final round");
  assert.ok(finalOpts.onToken, "the final round streams");
});

test("every round streams, because which one is the answer is not knowable in advance", async () => {
  /* The loop cannot predict whether a round will make tool calls. Streaming
     only the round it guessed was final meant the ordinary case — a model that
     stops looking on step two of three — arrived with no streaming at all. So
     all rounds stream and the text is reclassified afterwards. */
  const model = scripted([{ text: "looking", calls: [{ name: "memory_search" }] }, "answer"]);
  const r = await runAgent(base({ chat: model.chat }));
  assert.ok(model.opts[0].onToken, "the tool round streams too");
  assert.ok(model.opts[1].onToken, "and so does the answer");
  assert.equal(r.answer, "answer");

  /* Both rounds are inside the budget, so both are offered tools — the model
     simply stopped asking. Tools are withheld only on the *forced* final
     round, which the step-ceiling test covers. */
  assert.ok(model.opts[0].tools, "tools offered while there is budget");
  assert.ok(model.opts[1].tools, "and still offered on an early finish");
});

test("a round that made calls is reclassified: its tokens belong to the thought, not the answer", async () => {
  const model = scripted([{ text: "let me check", calls: [{ name: "memory_search" }] }, "the real answer"]);
  const events: string[] = [];
  const r = await runAgent(base({ chat: model.chat, onEvent: (e) => events.push(`${e.kind}:${"step" in e ? e.step : ""}`) }));

  /* The renderer's contract: tokens arrive tagged with a step, and a `calling`
     event on that same step is the signal to move them into the trace. */
  assert.ok(events.includes("token:1"), "the tool round emitted tokens");
  assert.ok(events.includes("calling:1"), "and then revealed itself as a tool round");
  assert.equal(r.trace.steps[0].thought, "let me check", "which is where that text ended up");
  assert.equal(r.answer, "the real answer", "and not in the answer");
});

test("the total tool-output budget stops further tool use", async () => {
  const huge = "x".repeat(13000);
  const model = scripted([
    { text: "one", calls: [{ name: "memory_search" }] },
    { text: "two", calls: [{ name: "memory_search" }] },
    "answer after the budget"
  ]);
  const tools = runner(() => ({ ok: true, text: huge }));
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, maxSteps: 8 }));

  assert.equal(tools.seen.length, 1, "one oversized result closed the window");
  assert.equal(r.answer, "two", "the next round was forced to prose");
  assert.equal(r.trace.truncated, false, "the step ceiling was not what stopped it");
});

/* --------------------------------------------------------------- batching */

test("independent calls in one round run together and all come back", async () => {
  const model = scripted([
    { text: "checking both", calls: [{ name: "memory_search" }, { name: "memory_search", args: { query: "b" } }] },
    "answer"
  ]);
  const tools = runner((name, args) => ({ ok: true, text: `${name}:${JSON.stringify(args)}` }));
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn }));

  assert.equal(r.trace.steps[0].runs.length, 2);
  const toolMsgs = model.sent[1].filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2, "both results were sent back");
});

/* ------------------------------------------------------------- write gate */

test("proposals and commits are collected across the whole loop", async () => {
  const model = scripted([
    { text: "saving", calls: [{ name: "memory_write" }, { name: "memory_write" }] },
    "noted"
  ]);
  let n = 0;
  const tools = runner(() =>
    n++ === 0
      ? { ok: true, text: "queued", proposed: [{ id: "q1", text: "a fact", kind: "memory" }] }
      : { ok: true, text: "saved", committed: [{ id: "m1", text: "another", kind: "memory" }] }
  );
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn }));

  assert.equal(r.proposed.length, 1);
  assert.equal(r.committed.length, 1);
  assert.equal(r.proposed[0].id, "q1");
});

test("write tools are absent from the prompt when writes are off", async () => {
  const model = scripted(["answer"]);
  await runAgent(base({ chat: model.chat, tools: TOOLS.filter((t) => t.kind === "read"), allowWrites: false }));
  const system = model.sent[0][0];
  assert.equal(system.role, "system");
  assert.match(system.content, /writing is switched off/i);
});

/* ---------------------------------------------------------- text protocol */

test("the text protocol parses a fenced block and feeds results back as prose", async () => {
  const model = scripted([
    'Let me look.\n```drill-call\n{"calls":[{"name":"memory_search","args":{"query":"adam"}}]}\n```',
    "Adam is what you settled on."
  ]);
  const tools = runner(() => ({ ok: true, text: "they chose Adam" }));
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, protocol: "text" }));

  assert.equal(r.trace.protocol, "text");
  assert.deepEqual(tools.seen, ["memory_search"]);
  assert.equal(r.trace.steps[0].thought, "Let me look.", "the block is stripped from the shown intent");
  assert.equal(r.answer, "Adam is what you settled on.");

  /* No `tool` role on this path — the result rides a user message, clearly
     marked as machine output. */
  const second = model.sent[1];
  assert.equal(second.filter((m) => m.role === "tool").length, 0);
  assert.match(second[second.length - 1].content, /TOOL RESULTS[\s\S]*they chose Adam/);
  assert.equal(second[second.length - 1].role, "user");
});

test("the text catalogue is in the system prompt, and native's is not", async () => {
  const textModel = scripted(["hi"]);
  await runAgent(base({ chat: textModel.chat, protocol: "text" }));
  assert.match(textModel.sent[0][0].content, /memory_search/, "text mode lists tools in the prompt");

  const nativeModel = scripted(["hi"]);
  await runAgent(base({ chat: nativeModel.chat, protocol: "native" }));
  assert.doesNotMatch(nativeModel.sent[0][0].content, /drill-call/, "native mode does not pay for the prose catalogue");
});

test("a malformed drill-call block is ignored and the prose still answers", async () => {
  const model = scripted(["Here you go.\n```drill-call\n{not json at all\n```"]);
  const tools = runner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, protocol: "text" }));
  assert.deepEqual(tools.seen, [], "nothing ran");
  assert.equal(r.answer, "Here you go.", "the block is stripped from the answer");
});

test("parseTextCalls finds every block, twice in a row", () => {
  /* The regex is module-level and /g. A shared lastIndex between calls would
     make the second parse start mid-string and silently find nothing — which
     would only show up on the loop's second step. */
  const reply = 'a\n```drill-call\n{"calls":[{"name":"one"}]}\n```\nb\n```drill-call\n{"calls":[{"name":"two"}]}\n```';
  for (let i = 0; i < 2; i++) {
    const { calls, thought } = parseTextCalls(reply);
    assert.deepEqual(calls.map((c) => c.name), ["one", "two"], `pass ${i + 1}`);
    assert.equal(thought, "a\n\nb");
  }
});

/* ----------------------------------------------------------------- aborts */

test("an aborted signal stops the loop rather than running another round", async () => {
  const controller = new AbortController();
  const model = scripted([{ text: "one", calls: [{ name: "memory_search" }] }, "never reached"]);
  const tools = runner(() => {
    controller.abort();
    return { ok: true, text: "ok" };
  });
  await assert.rejects(
    () => runAgent(base({ chat: model.chat, runTool: tools.fn, signal: controller.signal })),
    (e: Error) => e.name === "AbortError"
  );
});

/* ------------------------------------------------------------------ trace */

test("the trace records intent, calls and timing for every step", async () => {
  const model = scripted([{ text: "checking your cards", calls: [{ name: "memory_search", args: { query: "x" } }] }, "answer"]);
  const r = await runAgent(base({ chat: model.chat }));
  const step = r.trace.steps[0];

  assert.equal(step.thought, "checking your cards");
  assert.equal(step.runs[0].call.name, "memory_search");
  assert.deepEqual(step.runs[0].call.args, { query: "x" });
  assert.equal(step.runs[0].result.ok, true);
  assert.ok(step.runs[0].ms >= 0);
  assert.ok(r.trace.totalMs >= 0);
});

test("events are emitted in order so the UI can narrate the loop", async () => {
  const model = scripted([{ text: "looking", calls: [{ name: "memory_search" }] }, "answer"]);
  const kinds: string[] = [];
  await runAgent(base({ chat: model.chat, onEvent: (e) => kinds.push(e.kind) }));

  /* One tool round, then the answer. `answering` fires when the loop knows it
     has stopped looking — which is after the reply came back with no calls,
     not before the request. */
  const withoutTokens = kinds.filter((k) => k !== "token");
  assert.deepEqual(withoutTokens, ["thinking", "thought", "calling", "called", "thinking", "answering"]);
  assert.ok(kinds.includes("token"), "tokens streamed");
});

/* ------------------------------------------------------------------ usage */

test("usage is summed across every request, not just the last", async () => {
  const model = scripted([{ text: "one", calls: [{ name: "memory_search" }] }, "answer"]);
  let n = 0;
  const chat: ChatFn = async (m, o) => {
    o.onUsage?.({ promptTokens: 100, completionTokens: 10, reportedCost: 0.001 });
    return n++ === 0 ? "one" : "answer";
  };
  /* Re-script through the same fake so tool calls still fire on round one. */
  const withCalls: ChatFn = async (m, o) => {
    o.onUsage?.({ promptTokens: 100, completionTokens: 10, reportedCost: 0.001 });
    if (n++ === 0) {
      o.onToolCalls?.([{ id: "c0", name: "memory_search", args: {} }]);
      return "one";
    }
    return "answer";
  };
  void chat;
  const r = await runAgent(base({ chat: withCalls }));
  assert.equal(r.usage.promptTokens, 200, "both requests counted");
  assert.equal(r.usage.completionTokens, 20);
  assert.ok(Math.abs((r.usage.reportedCost || 0) - 0.002) < 1e-9, "cost is summed, not replaced");
});

/* ------------------------------------------------------------------- plan */

/** A runner that behaves like the real plan tools: writes into the run scratch
 *  the loop owns, so the close-out check has something real to check. */
function planRunner() {
  const seen: string[] = [];
  const fn: RunToolFn = async (name, args, ctx) => {
    seen.push(name);
    if (name === "plan") {
      const items = String(args.steps || "")
        .split("\n")
        .filter(Boolean)
        .map((text, i) => ({ id: String(i + 1), text, status: i === 0 ? ("doing" as const) : ("todo" as const), note: "" }));
      ctx.scratch.plan = { goal: String(args.goal || ""), items };
      ctx.scratch.emit({ kind: "plan", plan: ctx.scratch.plan });
      return { ok: true, text: `plan set, ${items.length} steps` };
    }
    if (name === "plan_step") {
      const item = ctx.scratch.plan?.items.find((i) => i.id === String(args.id));
      if (item) {
        item.status = args.status === "dropped" ? "dropped" : "done";
        item.note = String(args.note || "");
      }
      ctx.scratch.emit({ kind: "plan", plan: ctx.scratch.plan! });
      return { ok: true, text: "closed" };
    }
    if (name === "note") {
      ctx.scratch.notes.push(String(args.text || ""));
      ctx.scratch.emit({ kind: "note", text: String(args.text || "") });
      return { ok: true, text: "noted" };
    }
    return { ok: true, text: `result of ${name}` };
  };
  return { fn, seen };
}

test("the plan reaches the trace, with each step's status and note", async () => {
  const model = scripted([
    { text: "planning", calls: [{ name: "plan", args: { goal: "Find the weak spot", steps: "check cards\ncheck reviews" } }] },
    { text: "one done", calls: [{ name: "plan_step", args: { id: "1", note: "softmax is failing" } }] },
    { text: "two done", calls: [{ name: "plan_step", args: { id: "2", note: "they wrote the sigmoid form" } }] },
    "Here is what is wrong."
  ]);
  const tools = planRunner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, planning: true, tools: withPlan(), maxSteps: 8 }));

  assert.equal(r.answer, "Here is what is wrong.");
  assert.equal(r.trace.plan?.goal, "Find the weak spot");
  assert.deepEqual(r.trace.plan?.items.map((i) => i.status), ["done", "done"]);
  assert.equal(r.trace.plan?.items[0].note, "softmax is failing");
  assert.equal(r.trace.unfinished, undefined, "nothing left open");
});

test("answering with plan steps open is handed back once, not accepted", async () => {
  /* The single best-documented failure of a long-running agent: declaring
     victory early. The plan is what makes it detectable, and this is the check
     that acts on it. */
  const model = scripted([
    { text: "planning", calls: [{ name: "plan", args: { goal: "g", steps: "step one\nstep two" } }] },
    "Done! Here is your answer.",
    { text: "fine, closing", calls: [{ name: "plan_step", args: { id: "1", note: "a" } }, { name: "plan_step", args: { id: "2", note: "b" } }] },
    "Now the real answer."
  ]);
  const tools = planRunner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, planning: true, tools: withPlan(), maxSteps: 8 }));

  assert.equal(r.answer, "Now the real answer.", "the premature answer was rejected");
  assert.deepEqual(r.trace.plan?.items.map((i) => i.status), ["done", "done"]);

  /* The nudge has to name the open steps — "you are not finished" without the
     list gives the model nothing to act on. */
  const nudge = model.sent[2].find((m) => m.content.includes("PLAN NOT CLOSED"));
  assert.ok(nudge, "the loop handed the plan back");
  assert.match(nudge!.content, /step one/);
  assert.match(nudge!.content, /step two/);
});

test("the nudge fires at most once, and what stays open is recorded", async () => {
  /* Nagging twice turns "you missed something" into a loop that burns the
     whole budget arguing. After one nudge the answer stands and the omission
     is recorded instead — visible, not enforced. */
  const model = scripted([
    { text: "planning", calls: [{ name: "plan", args: { goal: "g", steps: "step one\nstep two" } }] },
    "Ignoring the plan.",
    "Still ignoring the plan."
  ]);
  const tools = planRunner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, planning: true, tools: withPlan(), maxSteps: 8 }));

  assert.equal(r.answer, "Still ignoring the plan.", "the second answer is accepted");
  assert.deepEqual(r.trace.unfinished, ["step one", "step two"], "and the omission is on the record");
  const nudges = model.sent.flat().filter((m) => m.content.includes("PLAN NOT CLOSED"));
  assert.equal(nudges.length, 1, "nudged exactly once");
});

test("a dropped step counts as closed — deciding it does not matter is a real outcome", async () => {
  const model = scripted([
    { text: "planning", calls: [{ name: "plan", args: { goal: "g", steps: "relevant\nirrelevant" } }] },
    {
      text: "closing",
      calls: [
        { name: "plan_step", args: { id: "1", note: "found it" } },
        { name: "plan_step", args: { id: "2", status: "dropped", note: "not related after all" } }
      ]
    },
    "answer"
  ]);
  const tools = planRunner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, planning: true, tools: withPlan(), maxSteps: 8 }));

  assert.equal(r.answer, "answer", "not nudged — every step is closed");
  assert.equal(r.trace.unfinished, undefined);
  assert.equal(r.trace.plan?.items[1].status, "dropped");
});

test("notes are collected onto the trace", async () => {
  const model = scripted([
    { text: "thinking", calls: [{ name: "note", args: { text: "They confuse softmax with sigmoid." } }] },
    "answer"
  ]);
  const tools = planRunner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, planning: true, tools: withPlan() }));
  assert.deepEqual(r.trace.notes, ["They confuse softmax with sigmoid."]);
});

test("plan and note events reach the UI as they happen", async () => {
  const model = scripted([
    { text: "planning", calls: [{ name: "plan", args: { goal: "g", steps: "a\nb" } }] },
    { text: "closing", calls: [{ name: "plan_step", args: { id: "1", note: "x" } }, { name: "note", args: { text: "n" } }] },
    "answer"
  ]);
  const tools = planRunner();
  const seen: string[] = [];
  await runAgent(base({ chat: model.chat, runTool: tools.fn, planning: true, tools: withPlan(), maxSteps: 8, onEvent: (e) => seen.push(e.kind) }));
  assert.ok(seen.includes("plan"), "the plan panel can render as it is written");
  assert.ok(seen.includes("note"));
});

test("without planning there is no plan, no nudge, and no plan tools in the prompt", async () => {
  /* The reactive mode must stay cheap. A plan on a two-lookup question costs
     an extra request to say what it was about to do anyway. */
  const model = scripted(["straight answer"]);
  const r = await runAgent(base({ chat: model.chat, protocol: "text" }));
  assert.equal(r.trace.plan, undefined);
  assert.doesNotMatch(model.sent[0][0].content, /WORKING TO A PLAN/);

  const deep = scripted(["straight answer"]);
  await runAgent(base({ chat: deep.chat, protocol: "text", planning: true, tools: withPlan() }));
  assert.match(deep.sent[0][0].content, /WORKING TO A PLAN/);
});

/* --------------------------------------------------- protocol example rot */

test("the text protocol's worked example always names a tool that exists", () => {
  /* This is a regression test for a real bug: the example was hardcoded as
     `memory_search` and survived the rename that deleted that tool, so every
     local model was shown an example calling something that would return "no
     tool called memory_search". It only affected the text protocol, which is
     the path least likely to be noticed. The example is now derived. */
  const rules = textProtocolRules(TOOLS);
  const named = [...rules.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(named.length, "the rules show a worked example");
  for (const n of named) {
    assert.ok(TOOLS.some((t) => t.name === n), `example names "${n}", which is not in the catalogue`);
  }

  /* And the argument it demonstrates has to be real too — an example with an
     invented parameter teaches the model to send one. */
  const tool = TOOLS.find((t) => t.name === named[0])!;
  const args = [...rules.matchAll(/"args":\{"([a-z_]+)"/g)].map((m) => m[1]);
  for (const a of args) {
    assert.ok(a in tool.schema.properties, `example passes "${a}", which ${tool.name} does not accept`);
  }
});

test("the example prefers a tool that actually takes an argument", () => {
  /* Picking the first read tool outright landed on `overview`, whose schema is
     empty — a valid example demonstrating nothing, when passing arguments is
     exactly the half a text-protocol model gets wrong. */
  const mixed: Tool[] = [
    { name: "overview", description: "d", scope: "global", kind: "read", schema: { properties: {}, required: [] }, run: () => ({ ok: true, text: "" }) },
    ...TOOLS
  ];
  const rules = textProtocolRules(mixed);
  assert.doesNotMatch(rules, /"name":"overview"/, "skipped the argument-less tool");
  assert.match(rules, /"args":\{"query"/, "and demonstrates a real argument");
});

test("a catalogue where nothing takes arguments still produces a valid example", () => {
  const noArgs: Tool[] = [
    { name: "overview", description: "d", scope: "global", kind: "read", schema: { properties: {}, required: [] }, run: () => ({ ok: true, text: "" }) }
  ];
  const rules = textProtocolRules(noArgs);
  assert.match(rules, /"name":"overview","args":\{\}/);
  assert.doesNotMatch(rules, /undefined/);
});

/* --------------------------------------------------------------- harness */

test("an identical read is not executed twice, whatever order the arguments arrive in", async () => {
  const model = scripted([
    { text: "looking", calls: [{ name: "memory_search", args: { query: "adam", limit: 2 } }] },
    { text: "looking again", calls: [{ name: "memory_search", args: { limit: 2, query: "adam" } }] },
    "They settled on Adam."
  ]);
  const tools = runner(() => ({ ok: true, text: "they chose Adam" }));
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn }));

  assert.deepEqual(tools.seen, ["memory_search"], "the second call was not a second lookup");
  assert.equal(r.answer, "They settled on Adam.");
  const told = model.sent[2].filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  assert.match(told, /Already ran/);
  assert.ok(model.sent[2].some((m) => m.content.includes("NO NEW INFORMATION")), "the round was handed back once");
});

test("identical reads asked together run once", async () => {
  const model = scripted([
    {
      text: "both",
      calls: [
        { name: "memory_search", args: { query: "a" } },
        { name: "memory_search", args: { query: "a" } }
      ]
    },
    "answer"
  ]);
  const tools = runner(() => ({ ok: true, text: "once" }));
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn }));

  assert.deepEqual(tools.seen, ["memory_search"]);
  assert.equal(r.trace.steps[0].runs.length, 2, "both calls are still on the trace");
  assert.match(r.trace.steps[0].runs[0].result.text, /once/);
  assert.match(r.trace.steps[0].runs[1].result.text, /once/);
});

test("a second round that learns nothing ends the loop", async () => {
  const same = { name: "memory_search", args: { query: "adam" } };
  const model = scripted([
    { text: "one", calls: [same] },
    { text: "two", calls: [same] },
    { text: "three", calls: [same] },
    "four would have been a call"
  ]);
  const tools = runner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, maxSteps: 8 }));

  assert.deepEqual(tools.seen, ["memory_search"]);
  /* Round one runs, round two is handed back, round three sets the stop, and
     the fourth request is prose only — its text is the answer, calls or not. */
  assert.equal(r.answer, "four would have been a call");
  assert.equal(model.calls(), 4);
  assert.equal(model.opts[3].tools, undefined, "the stalled loop is not offered tools again");
  /* The warning is one message carried forward, so later requests still contain
     it. A second push would put two of them on the final request. */
  const last = model.sent[model.sent.length - 1];
  assert.equal(last.filter((m) => m.content.includes("NO NEW INFORMATION")).length, 1, "warned once, then stopped");
});

test("a tool this conversation was not offered is not executed", async () => {
  const model = scripted([{ text: "deleting", calls: [{ name: "memory_write" }] }, "I cannot do that."]);
  const tools = runner();
  const reads = TOOLS.filter((t) => t.kind === "read");
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, tools: reads, allowWrites: false }));

  assert.deepEqual(tools.seen, [], "the write never ran");
  assert.equal(r.answer, "I cannot do that.");
  const toolMsg = model.sent[1].find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(toolMsg!.content, /memory_write/);
  assert.match(toolMsg!.content, /memory_search/, "the refusal names what is actually available");
  assert.doesNotMatch(toolMsg!.content, /plan/, "and does not advertise a tool this conversation cannot call");
});

test("deep mode answering with no plan is handed back once", async () => {
  const model = scripted([
    "Here is the answer, no plan.",
    { text: "planning", calls: [{ name: "plan", args: { goal: "g", steps: "look" } }] },
    { text: "done", calls: [{ name: "plan_step", args: { id: "1", note: "found it" } }] },
    "Now the real answer."
  ]);
  const tools = planRunner();
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, planning: true, tools: withPlan(), maxSteps: 8 }));

  assert.equal(r.answer, "Now the real answer.");
  const final = model.sent[model.sent.length - 1];
  assert.equal(final.filter((m) => m.content.includes("PLAN REQUIRED")).length, 1, "asked for a plan once");
});

test("deep mode's prompt names the tools it was given and no others", async () => {
  const model = scripted(["x"]);
  const tools: Tool[] = [
    marked("outline", { opensPlan: true }),
    marked("close_step", { closesPlan: true }),
    marked("jot", { keepsNote: true }),
    marked("standing", { reportsStanding: true }),
    marked("web_lookup", { searchesWeb: true })
  ];
  await runAgent(base({ chat: model.chat, protocol: "text", planning: true, tools }));
  const sys = model.sent[0][0].content;
  assert.match(sys, /WORKING TO A PLAN/);
  assert.match(sys, /`outline`/);
  assert.match(sys, /`close_step`/);
  assert.match(sys, /`jot`/);
  assert.match(sys, /`standing`/);
  assert.match(sys, /`web_lookup`/);
  assert.doesNotMatch(sys, /`plan_step`/);
  assert.doesNotMatch(sys, /call `plan`/);
});

test("the prompt does not name a standing or web tool it was not given", async () => {
  const model = scripted(["hi"]);
  await runAgent(base({ chat: model.chat, protocol: "text" }));
  const sys = model.sent[0][0].content;
  assert.doesNotMatch(sys, /recurring confusions/);
  assert.doesNotMatch(sys, /web_lookup/);
});

test("older tool results are shortened once the window fills, and the latest stays whole", async () => {
  const big = "y".repeat(5000);
  const model = scripted([
    { text: "first", calls: [{ name: "memory_search", args: { query: "a" } }] },
    { text: "second", calls: [{ name: "memory_search", args: { query: "b" } }] },
    "answer"
  ]);
  let n = 0;
  const tools = runner(() => ({ ok: true, text: big + n++ }));
  const r = await runAgent(base({ chat: model.chat, runTool: tools.fn, maxSteps: 6 }));

  assert.equal(r.answer, "answer");
  const toolMsgs = model.sent[2].filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.match(toolMsgs[0].content, /earlier result shortened/);
  assert.ok(toolMsgs[0].content.length < 1000, "the older result was cut");
  assert.ok(toolMsgs[1].content.length > 5000, "the latest result is kept whole");
});
