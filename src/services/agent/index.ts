/* ============================================================================
 * services/agent/index.ts — where the loop meets the app.
 *
 * loop.ts is deliberately ignorant: it takes a transport and a tool runner and
 * knows nothing about backends, projects or stores. This file is the one place
 * that supplies both, so there is exactly one answer to "what can the
 * assistant see, and how does it call things" — and swapping the transport for
 * a server endpoint later means changing `chat` here and nothing else.
 * ========================================================================== */
import * as AI from "@/services/ai";
import { runAgent, type AgentResult } from "./loop";
import { protocolFor } from "./protocol";
import { runTool, toolsFor } from "./tools";
import type { AgentEvent } from "@/types/agent";
import type { BackendType, ChatMessage, Citation } from "@/types";

export { runAgent } from "./loop";
export { TOOLS, toolsFor, runTool } from "./tools";
export { protocolFor } from "./protocol";

export interface AgentTurnOpts {
  /** Persona + the deterministic context block, exactly as the single-call
   *  path built it. The loop adds to this rather than replacing it: fixed
   *  context is cheaper than a tool call, so anything reliably worth knowing
   *  should already be in here. */
  system: string;
  history: ChatMessage[];
  projectId: string;
  conversationId: string;
  turnId: string;
  /** Which backend this thread resolved to, which decides the protocol. */
  backend: BackendType;
  maxSteps: number;
  /** False for the scratch thread — no decks, no journal, no exams, so the
   *  project tools would only offer the model things it cannot use. */
  inProject: boolean;
  /** False turns the loop read-only. The catalogue is filtered rather than the
   *  model being asked nicely, because "please do not write" is not a
   *  permission model. */
  allowWrites: boolean;
  /** Deep mode: plan first, close every step, then answer. "auto" is voice:
   *  a plan is offered, not required. */
  planning?: boolean | "auto";
  /** Voice mode may search the web as a tool. Only honoured where the backend
   *  can search — the caller asks availability() and passes the answer. */
  web?: boolean;
  /** Sources a web lookup drew on, for the turn's receipt. */
  onCitations?: (cs: Citation[]) => void;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  /** Per-call backend/model override, so a thread pinned to one model does not
   *  get retargeted by a change to the global default. */
  override?: { backend?: BackendType | ""; model?: string };
}

/**
 * Run one agent-mode message.
 *
 * Everything the loop needs, resolved here: which tools are in scope, which
 * protocol the backend speaks, and a transport that is `AI.chat` with the
 * override already bound — so usage metering, the run transcript and pricing
 * all keep working for every request the loop makes, not just the first.
 */
export function runAgentTurn(opts: AgentTurnOpts): Promise<AgentResult> {
  const planning = opts.planning === "auto" ? "auto" : !!opts.planning;
  const tools = toolsFor({ inProject: opts.inProject, allowWrites: opts.allowWrites, planning, web: !!opts.web });
  const found: Citation[] = [];
  /* One search, answered briefly, through the same model the thread uses —
     and metered like every other call because it goes through AI.chat. */
  const web = opts.web
    ? async (query: string, signal?: AbortSignal) => {
        let citations: Citation[] = [];
        const text = await AI.chat(
          [
            {
              role: "system",
              content: "Answer from the search results in one short paragraph of plain facts. Name the sources you relied on."
            },
            { role: "user", content: query }
          ],
          {
            temperature: 0.2,
            maxTokens: 500,
            signal,
            label: "voice web",
            actions: ["web"],
            onCitations: (cs) => {
              citations = cs;
            }
          },
          opts.override
        );
        for (const c of citations) if (!found.some((f) => f.url === c.url)) found.push(c);
        opts.onCitations?.([...found]);
        return { text, citations };
      }
    : undefined;
  return runAgent({
    system: opts.system,
    history: opts.history,
    tools,
    protocol: protocolFor(opts.backend),
    ctx: {
      projectId: opts.projectId,
      conversationId: opts.conversationId,
      turnId: opts.turnId,
      signal: opts.signal,
      web
    },
    maxSteps: Math.max(1, opts.maxSteps),
    allowWrites: opts.allowWrites,
    planning,
    /* Bound here rather than passed through, so every step of the loop lands
       on the run transcript and the usage ledger the same way a single call
       does. A loop whose steps 2..n were invisible to the meter would
       under-report its own cost by most of it. */
    chat: (messages, chatOpts) => AI.chat(messages, chatOpts, opts.override),
    runTool,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    signal: opts.signal,
    onEvent: opts.onEvent
  });
}
