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
 *
 * And four guards the model cannot talk its way around. A prompt that says
 * "do not" is a suggestion; these are the harness:
 *
 *   offered tools  a call whose name was not in this conversation's catalogue
 *                  is refused and never executed. Filtering the prompt is not
 *                  a permission model if `runTool` still runs whatever was
 *                  asked for — a text-protocol model can type any name.
 *   identical reads
 *                  the same read with the same arguments is not run twice.
 *                  The result is already in the transcript; paying for it
 *                  again is how a loop fills its own window with copies.
 *   a stalled round
 *                  a round that learns nothing is handed back once. The next
 *                  one ends the loop. Nagging on every repeat burns the budget
 *                  arguing, which is the same failure as the plan close-out.
 *   a missing plan
 *                  Deep mode that answers without writing a plan is handed
 *                  back once. An agent with no stated plan cannot be caught
 *                  declaring victory, which is why the plan exists.
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

/** Where older tool results start being shortened. Below this the transcript
 *  still holds every result in full; above it, everything but the latest
 *  round is cut to a head. The latest round stays whole — that is the
 *  evidence the next decision actually turns on. */
const COMPACT_AT = 8000;
const COMPACT_KEEP = 480;
const SHORTENED = "\n…earlier result shortened to leave room for the answer. The latest result is still complete.";

/** Stable identity of a call. Key order from the model is not significant,
 *  and an omitted argument is the same call as an empty one — otherwise
 *  "the same lookup" misses the case the model is most likely to repeat. */
function callKey(name: string, args: Record<string, unknown>): string {
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v == null || v === "") continue;
    norm[k] = v;
  }
  return name + "\0" + JSON.stringify(norm);
}

/** Shorten tool results that are no longer the latest round. Idempotent: a
 *  result already shortened stays as it is, so a second pass cannot eat the
 *  head it kept. */
function compactBefore(msgs: ChatMessage[], protectFrom: number, historyEnd: number): void {
  for (let i = historyEnd; i < protectFrom; i++) {
    const m = msgs[i];
    const toolish = m.role === "tool" || (m.role === "user" && m.content.startsWith("=== TOOL RESULTS ==="));
    if (!toolish || m.content.length <= COMPACT_KEEP || m.content.endsWith(SHORTENED)) continue;
    msgs[i] = { ...m, content: m.content.slice(0, COMPACT_KEEP) + SHORTENED };
  }
}

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

  /* Two nudges, each firing at most once, and they are different failures.
     Close-out: a written plan with steps still open. Missing plan: Deep mode
     answered without writing one at all. Sharing one flag would let the first
     failure spend the only correction and the second go through unnoticed.
     Nagging twice about the *same* failure is the thing that burns the budget
     arguing, so each one still happens once and then the answer stands. */
  let closeNudged = false;
  let planNudged = false;
  /** Set once a whole round learned nothing. The next such round stops the
   *  loop; a round that does new work clears it, so one repeated lookup does
   *  not condemn a real investigation. */
  let sawRepeatRound = false;
  /** The next round asks for prose only, whatever budget remains. A stalled
   *  loop that is still offered tools spends the rest of its steps repeating
   *  the call it was just refused. */
  let forceProse = false;
  /** Calls already attempted this turn, so a repeat can be recognised before
   *  it is executed. Recorded at the end of the round: two identical reads
   *  asked together are one lookup, not a repeat of each other. */
  const attempted = new Set<string>();
  /** In-flight reads, so a pair of identical calls in one block share one
   *  execution instead of racing two copies. */
  const reads = new Map<string, Promise<ToolResult>>();
  /** Whether that read succeeded, so a repeat is reported as a miss only when
   *  the original was. A repeat of a good result is not a failure — painting
   *  it as one teaches the model to route around evidence it already has, and
   *  the trace would show a miss for a lookup that worked. */
  const readOk = new Map<string, boolean>();
  /** Start index of each round's tool results. Compaction keeps the latest
   *  span intact and shortens everything before it. */
  const resultSpans: number[] = [];
  const offered = opts.tools.map((t) => t.name);
  const offeredSet = new Set(offered);
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const closer = opts.tools.find((t) => t.closesPlan)?.name;

  const system = buildAgentSystem({
    base: opts.system,
    tools: opts.tools,
    protocol: opts.protocol,
    allowWrites: opts.allowWrites,
    planning: opts.planning === "auto" ? "auto" : !!opts.planning,
    maxSteps: opts.maxSteps
  });

  const msgs: ChatMessage[] = [{ role: "system", content: system }, ...opts.history];
  /* Compaction must never touch the conversation itself — only tool results
     this loop appended. A learner who pasted a result banner is not a result. */
  const historyEnd = msgs.length;
  const nativeTools = native ? compileNative(opts.tools) : undefined;

  for (let step = 1; ; step++) {
    /* Older rounds are shortened only once a later round exists and the
       window is actually filling. The latest result stays whole. */
    if (toolChars >= COMPACT_AT && resultSpans.length >= 2) compactBefore(msgs, resultSpans[resultSpans.length - 1], historyEnd);

    /* The last permitted round is asked for prose only. Leaving the tools in
       and hoping the model notices its budget is spent produces a reply that
       is nothing but a tool call, which the loop then has to discard — the
       learner waited for a request that could never have answered them.
       `forceProse` is the stall guard reaching the same end on purpose. */
    const isFinal = forceProse || step > opts.maxSteps || toolChars >= MAX_TOOL_CHARS;
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
      if (openItems.length && !closeNudged && !isFinal) {
        closeNudged = true;
        msgs.push({ role: "assistant", content: reply });
        msgs.push({
          role: "user",
          content:
            "=== PLAN NOT CLOSED ===\nYou have not closed these steps of your own plan:\n" +
            openItems.map((i) => `${i.id}. ${i.text}`).join("\n") +
            "\nEither do them now, or close each with " +
            (closer ? "`" + closer + "`" : "the step tool") +
            ' marked "dropped" and a reason. ' +
            "Do not restate your answer until every step is closed."
        });
        continue;
      }

      /* Deep mode's other early-victory: answering without a plan, so there
         is nothing for the close-out check to catch. Voice ("auto") is not
         included — most of what is said aloud needs no plan, and demanding
         one would put a tax on every question. */
      if (opts.planning === true && !scratch.plan && !planNudged && !isFinal) {
        planNudged = true;
        msgs.push({ role: "assistant", content: reply });
        msgs.push({
          role: "user",
          content:
            "=== PLAN REQUIRED ===\nYou answered without a plan. Deep mode starts by writing one: restate the " +
            "question, then list the specific things you will find out, and work them before you answer. " +
            "Do not restate this answer until that is done."
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
       throw that away. `prior` is the snapshot from before this block, so two
       copies of one call in the same block still count as one lookup. */
    const prior = new Set(attempted);
    const ran: { run: ToolRun; repeat: boolean }[] = await Promise.all(
      calls.map(async (call): Promise<{ run: ToolRun; repeat: boolean }> => {
        emit({ kind: "calling", step, call });
        const t0 = Date.now();
        const key = callKey(call.name, call.args);
        const repeat = prior.has(key);
        const tool = byName.get(call.name);
        let result: ToolResult;

        if (!offeredSet.has(call.name) || !tool) {
          /* Not executed. The list is this conversation's catalogue, not the
             full one — naming a write tool that was filtered out would teach
             the model to call it, which is the permission hole in reverse. */
          result = {
            ok: false,
            text:
              `No tool called "${call.name}" is available in this conversation. ` +
              `Available: ${offered.join(", ") || "(none)"}.`
          };
        } else if (repeat && tool.kind === "read") {
          const priorOk = readOk.get(key) !== false;
          result = {
            ok: priorOk,
            text: priorOk
              ? "Already ran this exact call earlier in this turn. The result is above and has not changed. " +
                "Do not call it again — change the question, or write the answer."
              : "This exact call already failed earlier in this turn. The reason is above. Do not repeat it."
          };
        } else if (tool.kind === "read") {
          let pending = reads.get(key);
          if (!pending) {
            pending = opts.runTool(call.name, call.args, ctx);
            reads.set(key, pending);
          }
          result = await pending;
          if (!readOk.has(key)) readOk.set(key, result.ok);
        } else {
          /* Writes are not deduped. Two saves with the same words are the
             model's to make; the memory gate already turns a real duplicate
             into a replacement, and a harness that dropped the second write
             would hide a commit the learner was owed. */
          result = await opts.runTool(call.name, call.args, ctx);
        }

        const skipped = !tool || (repeat && tool.kind === "read");
        const run: ToolRun = { call, result, ms: skipped ? 0 : Date.now() - t0 };
        emit({ kind: "called", step, run });
        return { run, repeat: repeat && (tool?.kind === "read" || !tool) };
      })
    );
    const runs = ran.map((r) => r.run);

    for (const r of runs) {
      toolChars += r.result.text.length;
      if (r.result.proposed) proposed.push(...r.result.proposed);
      if (r.result.committed) committed.push(...r.result.committed);
    }
    steps.push({ thought: thought.trim(), runs });
    for (const c of calls) attempted.add(callKey(c.name, c.args));

    /* Feed the results back. The two protocols differ only here. The span is
       recorded at the assistant message that owns this round, so compaction
       can keep this round and shorten only what came before it. */
    resultSpans.push(msgs.length);
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

    /* A round that learned nothing is handed back once, with the tools still
       available, so a repeated lookup can be followed by a different one.
       The second such round in a row ends the investigation: offering the
       tools again is paying for a request that can only repeat itself. A
       round that does new work clears the flag. */
    const stalled = ran.length > 0 && ran.every((r) => r.repeat);
    if (stalled) {
      if (sawRepeatRound) forceProse = true;
      else {
        sawRepeatRound = true;
        msgs.push({
          role: "user",
          content:
            "=== NO NEW INFORMATION ===\nEvery call in that round was one you had already made, or a tool this " +
            "conversation does not have. Use what is above, try a different call, or write the answer. " +
            "Repeating it again will end the investigation."
        });
      }
    } else sawRepeatRound = false;

    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
}
