/* ============================================================================
 * loop.ts — the agentic path: look, then answer.
 *
 * One function, and it does not know which backend it is talking to or which
 * protocol is in use — services/agent/protocol.ts has already flattened both
 * into `ToolCall[]` by the time anything here runs.
 *
 * `chat` is injected rather than imported. There is no API key in the
 * development environment (CLAUDE.md, "Verifying"), so a loop that reached for
 * services/ai directly could not be tested at all; with the transport as a
 * parameter, the whole control flow — stopping, budgets, aborts, malformed
 * calls, tools that throw — is exercised by loop.test.ts against a scripted
 * model. What genuinely cannot be tested here is real streaming and real
 * token accounting, and this comment is the honest record of that.
 *
 * Three budgets, all of which exist because an agent loop's failure mode is
 * spending rather than crashing:
 *
 *   maxSteps       rounds of tool use, from the effort dial
 *   MAX_TOOL_CHARS total tool output across the whole loop, after which the
 *                  tools go away and the model is told to answer
 *   per-tool caps  applied in tools.ts, so one call cannot eat the lot
 * ========================================================================== */
import { compileNative, parseTextCalls, renderTextResults } from "./protocol";
import { buildAgentSystem } from "./prompt";
import type {
  AgentEvent,
  AgentStep,
  AgentTrace,
  RunScratch,
  Tool,
  ToolCall,
  ToolContext,
  ToolProtocol,
  ToolResult,
  ToolRun
} from "@/types/agent";
import type { ChatMessage, ChatOpts, TokenUsage } from "@/types";

/**
 * Total characters of tool output one message may accumulate.
 *
 * Not a token count on purpose: this is a guard rail, not a budget to
 * optimise, and characters are exact and free where tokens would need a
 * tokeniser we deliberately do not ship. Roughly 3k tokens, which leaves room
 * for the conversation and the answer on any model worth using here.
 */
const MAX_TOOL_CHARS = 12000;

/** The transport, narrowed to what the loop needs. Matches services/ai.chat's
 *  shape so the real one drops in without an adapter. */
export type ChatFn = (messages: ChatMessage[], opts: ChatOpts) => Promise<string>;

/** The executor, injected for the same reason `chat` is.
 *
 *  services/agent/tools.ts reaches localStorage and IndexedDB through the
 *  stores, so importing it here would make this module unloadable under
 *  `node --test` and the loop's control flow — the part with all the budgets
 *  and the stopping rules — would have no tests at all. Passing it in costs
 *  one line at the call site and buys the whole test file. */
export type RunToolFn = (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface RunAgentOpts {
  /** Persona plus the deterministic context block — what the single-call path
   *  would have sent. The loop builds on it rather than replacing it. */
  system: string;
  /** The conversation so far, already windowed by the effort budget. */
  history: ChatMessage[];
  tools: Tool[];
  protocol: ToolProtocol;
  /** Everything except `scratch`, which the loop creates and owns — a
   *  caller supplying its own would let plan state leak between messages. */
  ctx: Omit<ToolContext, "scratch">;
  maxSteps: number;
  allowWrites: boolean;
  /** Deep mode: the assistant writes a plan first and must close every step
   *  before it answers. Off for the reactive mode, where a plan would be pure
   *  overhead on a two-lookup question. "auto" is voice mode: a plan may be
   *  written and, once written, is held to exactly the same close-out. */
  planning?: boolean | "auto";
  chat: ChatFn;
  runTool: RunToolFn;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentResult {
  /** The final prose. Never includes a tool block — those are stripped by the
   *  parser on the text path and never present on the native one. */
  answer: string;
  trace: AgentTrace;
  /** Everything the loop proposed or committed, flattened across all steps so
   *  the turn can render one receipt instead of one per step. */
  proposed: NonNullable<ToolResult["proposed"]>;
  committed: NonNullable<ToolResult["committed"]>;
  usage: TokenUsage;
}

function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + (b.promptTokens || 0),
    completionTokens: a.completionTokens + (b.completionTokens || 0),
    cachedPromptTokens: (a.cachedPromptTokens || 0) + (b.cachedPromptTokens || 0),
    reasoningTokens: (a.reasoningTokens || 0) + (b.reasoningTokens || 0),
    /* Summed, not replaced: every step is a separate billable request, and
       reporting only the last one's cost would under-report a five-step loop
       by most of its price. */
    reportedCost:
      a.reportedCost != null || b.reportedCost != null ? (a.reportedCost || 0) + (b.reportedCost || 0) : undefined
  };
}

/**
 * Run the loop.
 *
 * Never throws for a tool problem — a tool that fails reports the failure to
 * the model, which is the whole point of having a loop. It does throw for a
 * transport failure and for an abort, which the caller already knows how to
 * handle from the single-call path.
 */
export async function runAgent(opts: RunAgentOpts): Promise<AgentResult> {
  const started = Date.now();
  const native = opts.protocol === "native";
  const emit = opts.onEvent || (() => undefined);

  const steps: AgentStep[] = [];
  const proposed: NonNullable<ToolResult["proposed"]> = [];
  const committed: NonNullable<ToolResult["committed"]> = [];
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  let toolChars = 0;
  let truncated = false;

  /* Per-run state the plan and note tools write into. It lives exactly as long
     as this message; what survives is the trace saved on the turn. */
  const scratch: RunScratch = { plan: null, notes: [], emit };
  const ctx: ToolContext = { ...opts.ctx, scratch };

  /* Deep mode's close-out check, and it fires at most once. A model that
     stops with plan steps open gets told which, and one more round to close
     them — but nagging twice turns "you missed something" into a loop that
     burns the whole budget arguing, so after the nudge the answer stands and
     what is still open is recorded on the trace instead. */
  let nudged = false;

  const system = buildAgentSystem({
    base: opts.system,
    tools: opts.tools,
    protocol: opts.protocol,
    allowWrites: opts.allowWrites,
    planning: opts.planning === "auto" ? "auto" : !!opts.planning,
    maxSteps: opts.maxSteps
  });

  const msgs: ChatMessage[] = [{ role: "system", content: system }, ...opts.history];
  const nativeTools = native ? compileNative(opts.tools) : undefined;

  for (let step = 1; ; step++) {
    /* The last permitted round is asked for prose only. Leaving the tools in
       and hoping the model notices its budget is spent produces a reply that
       is nothing but a tool call, which the loop then has to discard — the
       learner waited for a request that could never have answered them. */
    const isFinal = step > opts.maxSteps || toolChars >= MAX_TOOL_CHARS;
    if (isFinal && step > 1) truncated = step > opts.maxSteps;

    emit({ kind: "thinking", step });

    let calls: ToolCall[] = [];
    const collected: ToolCall[] = [];
    let acc = "";

    const chatOpts: ChatOpts = {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      label: isFinal ? "agent answer" : `agent step ${step}`,
      onUsage: (u) => {
        usage = addUsage(usage, u);
      },
      /* Every round streams, including the ones that turn out to be tool
         rounds. The loop cannot know which this is until the reply completes —
         and streaming only the round it *predicted* was final meant the common
         case, a model that finishes looking on step two of three, arrived with
         no streaming at all. So tokens go out live and are reclassified: a
         round that made calls emits `calling`, and the renderer moves what it
         streamed into that step's thought. */
      onToken: (token: string, all: string) => {
        acc = all;
        emit({ kind: "token", step, token, acc: all });
      },
      /* Per round, and reset with it: each round is its own request, so a
         model that thinks on step two is not still thinking on step three.
         The accumulation is passed rather than the delta because the renderer
         is a scrolling window over the whole chain, not a log of chunks. */
      onReasoning: (_chunk: string, all: string) => {
        emit({ kind: "reasoning", step, acc: all });
      },
      ...(isFinal || !native
        ? {}
        : {
            tools: nativeTools,
            onToolCalls: (list) => {
              for (const c of list) collected.push(c);
            }
          })
    };

    const reply = await opts.chat(msgs, chatOpts);

    let thought = reply;
    if (!isFinal) {
      if (native) {
        calls = collected;
      } else {
        const parsed = parseTextCalls(reply);
        thought = parsed.thought;
        calls = parsed.calls;
      }
    }

    /* No calls means this was the answer. On the native path a model that
       ignores `tools` lands here on step one, which is the correct
       degradation: the loop becomes a single call. */
    if (!calls.length) {
      const openItems = scratch.plan?.items.filter((i) => i.status === "todo" || i.status === "doing") ?? [];

      /* The single most-documented failure of a long-running agent is
         declaring victory early, and a written plan is the only thing that
         makes it detectable. If steps are open and there is budget left, hand
         the list back once rather than accepting the answer. */
      if (openItems.length && !nudged && !isFinal) {
        nudged = true;
        msgs.push({ role: "assistant", content: reply });
        msgs.push({
          role: "user",
          content:
            "=== PLAN NOT CLOSED ===\nYou have not closed these steps of your own plan:\n" +
            openItems.map((i) => `${i.id}. ${i.text}`).join("\n") +
            "\nEither do them now, or close each with plan_step marked \"dropped\" and a reason. " +
            "Do not restate your answer until every step is closed."
        });
        continue;
      }

      emit({ kind: "answering", step });
      return {
        answer: (isFinal ? acc || reply : thought).trim(),
        trace: {
          steps,
          truncated,
          protocol: opts.protocol,
          totalMs: Date.now() - started,
          ...(scratch.plan ? { plan: scratch.plan } : {}),
          ...(scratch.notes.length ? { notes: scratch.notes } : {}),
          ...(openItems.length ? { unfinished: openItems.map((i) => i.text) } : {})
        },
        proposed,
        committed,
        usage
      };
    }

    if (thought.trim()) emit({ kind: "thought", step, text: thought.trim() });

    /* Independent calls in one block run together. The model is told to batch
       them for exactly this reason, and a loop that ran them in series would
       throw that away. */
    const runs: ToolRun[] = await Promise.all(
      calls.map(async (call): Promise<ToolRun> => {
        emit({ kind: "calling", step, call });
        const t0 = Date.now();
        const result = await opts.runTool(call.name, call.args, ctx);
        const run: ToolRun = { call, result, ms: Date.now() - t0 };
        emit({ kind: "called", step, run });
        return run;
      })
    );

    for (const r of runs) {
      toolChars += r.result.text.length;
      if (r.result.proposed) proposed.push(...r.result.proposed);
      if (r.result.committed) committed.push(...r.result.committed);
    }
    steps.push({ thought: thought.trim(), runs });

    /* Feed the results back. The two protocols differ only here. */
    if (native) {
      msgs.push({
        role: "assistant",
        content: thought,
        toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args }))
      });
      for (const r of runs) {
        msgs.push({ role: "tool", content: r.result.text, toolCallId: r.call.id, name: r.call.name });
      }
    } else {
      msgs.push({ role: "assistant", content: reply });
      msgs.push({ role: "user", content: renderTextResults(runs.map((r) => ({ call: r.call, text: r.result.text }))) });
    }

    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
}
