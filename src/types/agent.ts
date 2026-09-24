/* ============================================================================
 * agent.ts — the vocabulary of the agentic loop.
 *
 * START-HERE.md §2.2 locked "pipeline, not agent loop" and named the effort
 * dial as where a loop would land in v3. This is that: a second *mode* beside
 * the single-call path, never a replacement for it. The single call is still
 * the right shape for "explain this to me" and it stays the default; the loop
 * is for "go and find out", where the model has to look at three things before
 * it knows what to say.
 *
 * Two rules hold the whole design together, and both come straight out of
 * decisions that were locked for good reasons:
 *
 *   · A read tool may run freely. A *write* tool proposes — it goes through
 *     services/candidates and the project's autonomy policy exactly as distill
 *     does, so §2.4 ("nothing commits itself") survives giving the model hands.
 *   · Every tool result is capped in characters before it goes back up the
 *     wire. An agent loop that pastes sixty cards into its own context on step
 *     one has spent the window before it has answered anything.
 * ========================================================================== */
import type { MemoryScope, MemoryType } from "@/types/core";

/* ------------------------------------------------------------------ tools */

/** JSON Schema, cut down to the subset the tool catalogue actually uses. It is
 *  sent verbatim to backends that speak native tool calling, and rendered into
 *  prose for the ones that do not — see services/agent/protocol.ts. */
export interface ToolParam {
  type: "string" | "number" | "boolean";
  /** Written for the model. Say what the argument selects, not its type. */
  description: string;
  /** Present for closed sets, so the model does not invent a scope value. */
  enum?: readonly string[];
  default?: string | number | boolean;
}

export interface ToolSchema {
  properties: Record<string, ToolParam>;
  required: string[];
}

/**
 * Where a tool may be used.
 *
 *   project  needs a real project — decks, journal, exams, project memory
 *   global   works anywhere, including the scratch thread
 *
 * The catalogue is filtered by this before it is compiled into a prompt, which
 * is why a quick unrelated question never sees a `deck_search` it cannot
 * usefully call.
 */
export type ToolScope = "project" | "global";

/** A read tool answers a question. A write tool changes something, and is
 *  therefore subject to the autonomy policy — see `ToolResult.proposed`. */
export type ToolKind = "read" | "write";

export interface Tool {
  name: string;
  /** The one-line summary the model chooses from. This is the single highest
   *  leverage string in the whole loop: a vague description produces a model
   *  that calls the wrong tool and then apologises. Say what it returns and
   *  when to reach for it. */
  description: string;
  scope: ToolScope;
  kind: ToolKind;
  schema: ToolSchema;
  /** Rough character ceiling on this tool's own output, enforced by the
   *  executor rather than trusted to the tool. */
  maxChars?: number;
  /** The tool that opens a plan. Marked rather than looked up by name, so the
   *  prompt that invites a plan names it from the catalogue and a rename
   *  cannot leave the prompt pointing at a tool that no longer exists. */
  opensPlan?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/** What a tool is allowed to know about the call it is serving. Deliberately
 *  small: a tool that reads the globally-active project instead of this field
 *  would answer the wrong question whenever the loop runs for a conversation
 *  that is not the one on screen. */
export interface ToolContext {
  projectId: string;
  conversationId: string;
  /** The turn the loop is answering, so a written memory can record where it
   *  came from — MemoryOrigin has had no producer outside chat capture. */
  turnId: string;
  signal?: AbortSignal;
  /** One web search, answered in a paragraph with its sources — present only
   *  when this run may search. Supplied by the caller, which knows which
   *  backend and model the conversation resolves to; a tool reaching for the
   *  global default would search with a model the thread never chose. */
  web?: (query: string, signal?: AbortSignal) => Promise<{ text: string; citations: import("@/types").Citation[] }>;
  /** Mutable state for this one message. Tools that manage the plan and the
   *  scratchpad write here rather than to a store: none of it outlives the
   *  answer except as the trace recorded alongside it. */
  scratch: RunScratch;
}

/** The plan and notes for one run, owned by the loop and handed to tools. */
export interface RunScratch {
  plan: AgentPlan | null;
  notes: string[];
  /** Lets a tool announce a plan or note change without the loop having to
   *  diff the scratch after every call. */
  emit(e: AgentEvent): void;
}

export interface ToolResult {
  /** False for a refusal or a miss. The text still goes back to the model:
   *  "no cards matched" is information, and a silent empty result is what
   *  makes a model retry the same call three times. */
  ok: boolean;
  /** What the model sees. Plain text, already capped and already summarised —
   *  never raw JSON of a whole record. */
  text: string;
  /** Set by a write tool that went to the tray instead of committing, so the
   *  UI can say "3 proposed" and link to them rather than implying they
   *  landed. */
  proposed?: { id: string; text: string; kind: "memory" | "card" | "note" }[];
  /** Set by a write tool that did commit, under `auto` autonomy or for a fact
   *  the learner stated outright. */
  committed?: { id: string; text: string; kind: "memory" | "card" | "note" }[];
}

/* ------------------------------------------------------------------- plan */

/**
 * One thing the assistant said it would do.
 *
 * The plan exists because of the best-documented failure of long-running
 * agents: declaring victory early. An agent with no stated plan has nothing to
 * be measured against, so "I have finished" is unfalsifiable — by itself and by
 * the reader. Writing the plan down first turns finishing into a check.
 *
 * Status is the *only* mutable field, deliberately. Letting the model rewrite
 * item text mid-run lets it quietly redefine the job it failed to do, which is
 * the same failure wearing a different hat.
 */
export type PlanStatus = "todo" | "doing" | "done" | "dropped";

export interface PlanItem {
  id: string;
  /** Written once, at plan time, and never edited afterwards. */
  text: string;
  status: PlanStatus;
  /** What it found, one line — set when the item closes. This is what makes a
   *  finished plan readable on its own, without opening every tool result. */
  note: string;
}

export interface AgentPlan {
  /** The question restated as the assistant understood it. Worth showing: a
   *  misread question is visible here in one line, before the reader has spent
   *  a paragraph discovering it. */
  goal: string;
  items: PlanItem[];
}

/* ------------------------------------------------------------------- loop */

/** One request from the model to run one tool. `id` is the backend's own call
 *  id under native tool calling, and a synthesised one under the text
 *  protocol, so the two paths join up from here on. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** A call and what it returned, kept together so the trace can be rendered
 *  without re-running anything. */
export interface ToolRun {
  call: ToolCall;
  result: ToolResult;
  ms: number;
}

/** One turn of the loop: what the model said, and what it then did. */
export interface AgentStep {
  /** Prose the model wrote alongside its calls. Usually a sentence of intent
   *  — "let me check what you got wrong this week" — which is exactly what
   *  the trace should show, so it is kept rather than discarded. */
  thought: string;
  runs: ToolRun[];
}

/**
 * The whole loop, recorded.
 *
 * Persisted on the assistant Variant so it survives a reload. START-HERE §2.5
 * ("raw input is never destroyed") applies to the model's own working just as
 * much as to a journal entry: an answer you cannot audit is an answer you
 * cannot correct.
 */
export interface AgentTrace {
  steps: AgentStep[];
  /** True when the loop hit its step ceiling rather than finishing. The reply
   *  is still shown — it is just flagged as cut short, because an answer
   *  written without the last lookup is worth reading and worth doubting. */
  truncated: boolean;
  /** Which protocol actually ran, so a thin trace on a local model can be
   *  explained rather than looking like a bug. */
  protocol: ToolProtocol;
  totalMs: number;
  /** Deep mode only — the plan as it finished, items and all. */
  plan?: AgentPlan;
  /** The scratchpad, if the assistant kept one. Structured note-taking: what
   *  it worked out along the way, which is often worth more than the tool
   *  output it was derived from. */
  notes?: string[];
  /** Set when the loop was asked to close out an unfinished plan and could
   *  not. Surfaced rather than swallowed — an answer that skipped half its own
   *  plan is exactly the thing the plan exists to make visible. */
  unfinished?: string[];
}

/* --------------------------------------------------------------- protocol */

/**
 * How tool calls travel.
 *
 *   native  the backend's own `tools` / `tool_calls` fields — reliable, and
 *           what every hosted model is trained on
 *   text    a fenced ```drill-call block the model writes into its reply,
 *           parsed back out here
 *
 * The text protocol is not a fallback nobody uses: it is what lets the loop
 * run on Ollama and llama.cpp, which cannot be relied on for a `tools` field,
 * and it is the convention this codebase already uses for `drill-memory` and
 * `drill-journal`. One catalogue compiles to both.
 */
export type ToolProtocol = "native" | "text";

/* ---------------------------------------------------------------- streaming */

/**
 * Progress out of the loop, so the composer can say what is happening instead
 * of spinning. Every event is cheap and none are persisted — the AgentTrace is
 * the durable record.
 *
 * `token` carries its `step` because of an ambiguity that cannot be resolved
 * any earlier: the loop cannot know whether a round is a tool round or the
 * final answer until the reply is complete, so *every* round streams and the
 * text is reclassified afterwards. A round that turns out to have made tool
 * calls emits `calling`, and the renderer moves what it had streamed into that
 * step's thought. Buffering instead would mean the answer never streams at
 * all, which is the bug this shape exists to avoid.
 */
export type AgentEvent =
  | { kind: "thinking"; step: number }
  | { kind: "thought"; step: number; text: string }
  | { kind: "calling"; step: number; call: ToolCall }
  | { kind: "called"; step: number; run: ToolRun }
  /** The plan was written or an item changed status. Emitted separately from
   *  the tool run that caused it so the plan panel can update without the
   *  renderer having to know which tools happen to mutate a plan. */
  | { kind: "plan"; plan: AgentPlan }
  | { kind: "note"; text: string }
  /** The model's working on this round, accumulated. Separate from `thought`,
   *  which is what the model *said* on a tool round — this is what it thought
   *  before saying it, and a round can produce either, both or neither. */
  | { kind: "reasoning"; step: number; acc: string }
  /** The loop is done looking; what streams from here is the reply. */
  | { kind: "answering"; step: number }
  | { kind: "token"; step: number; token: string; acc: string };

/* ------------------------------------------------------- tool arg helpers */

/** The closed sets a tool argument may name, exported so the catalogue and
 *  the parser cannot drift apart. */
export const MEMORY_SCOPES: readonly (MemoryScope | "both")[] = ["global", "project", "both"];
export const MEMORY_TYPES_ENUM: readonly MemoryType[] = [
  "profile",
  "preference",
  "goal",
  "convention",
  "understanding",
  "open",
  "reference"
];
