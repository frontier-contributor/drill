/* ============================================================================
 * ChatContext — everything that happens when you press Enter.
 *
 * Owns the send/stream/abort/regenerate cycle and the streaming buffer. The
 * buffer is React state, deliberately separate from the persisted turn: a
 * reply arrives token by token, and writing each frame through the store to
 * IndexedDB would be pointless I/O. The finished text is committed once.
 * ========================================================================== */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import * as U from "@/lib/util";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import * as memoryStore from "@/services/memoryStore";
import * as memoryCapture from "@/services/memoryCapture";
import * as AI from "@/services/ai";
import { isAbort } from "@/services/ai/backends";
import { catalogueEntry, loadPricing, priceForModel } from "@/services/pricing";
import { buildContext } from "@/lib/chatContext";
import { getPersona } from "@/lib/personas";
import { budgetFor, deepSteps } from "@/lib/effort";
import { localTitle } from "@/lib/title";
import type { Effort } from "@/types/core";
import { costOf } from "@/lib/tokens";
import { resolveBackend, resolveEffort, resolveModel } from "@/lib/resolveSetting";
import { useRoute } from "./RouteContext";
import type { Attachment, ChatMode, Conversation, ContextSource, Turn, Usage, Variant } from "@/types/chat";
import { runAgentTurn } from "@/services/agent";
import { hydrate, type BinaryNeed } from "@/services/files/wire";
import { canTake } from "@/lib/modality";
import { carry, windowFor, type CarryContext } from "@/lib/files/carry";
import { collapseCanvases } from "@/lib/visuals/artifacts";
import type { AgentPlan, AgentTrace, ToolCall, ToolRun } from "@/types/agent";
import type { ChatActionId } from "@/lib/chatActions";
import type { BackendType, ChatMessage, Citation, Memory } from "@/types";

/** A one-off backend/model for a single regenerate call — applied to that
 *  variant only, never written to conversation.backend/model. */
type ModelOverride = { backend?: BackendType | ""; model?: string };

/** The empty reply a request is about to fill in.
 *
 *  One factory rather than the two identical literals send() and editUserTurn()
 *  each carried — which had drifted to the point of both falling back to
 *  `String(Math.random())` for an id, a value that can repeat and is used to
 *  find the turn again. `U.uuid()` is what the rest of the app uses. */
function blankAssistantTurn(): Turn {
  return { id: U.uuid(), role: "assistant", variants: [], active: 0, createdAt: Date.now() };
}

/**
 * The agent loop mid-flight, for the "what is it doing" panel.
 *
 * Keyed by step number rather than appended in arrival order, because the
 * events for one round do not arrive together: `thought` comes from the reply,
 * `calling` fires per tool before it runs, and `called` lands whenever that
 * tool finishes — and calls in a round run concurrently, so they finish out of
 * order. A running list would interleave two rounds the first time one tool
 * was slower than the next round's first.
 *
 * A step whose `calls` outnumber its `runs` has tools still in flight, which is
 * what makes "searching your memory…" possible: a call and its result are
 * separate events, and the interesting moment is the gap between them.
 */
export interface LiveStep {
  step: number;
  thought: string;
  calls: ToolCall[];
  runs: ToolRun[];
}

export interface AgentLive {
  steps: LiveStep[];
  answering: boolean;
  /** Deep mode's plan, updated in place as steps close. */
  plan: AgentPlan | null;
  notes: string[];
}

/** Upsert one step, without mutating the array React is rendering. */
function patchStep(live: AgentLive, step: number, fn: (s: LiveStep) => LiveStep): AgentLive {
  const steps = [...live.steps];
  const i = steps.findIndex((s) => s.step === step);
  const base: LiveStep = i >= 0 ? steps[i] : { step, thought: "", calls: [], runs: [] };
  const next = fn(base);
  if (i >= 0) steps[i] = next;
  else steps.push(next);
  steps.sort((a, b) => a.step - b.step);
  return { ...live, steps };
}

/** One attachment's share of a message: its text always, and — when it rides
 *  as itself — the files to read at send time. */
function carryInto(
  a: Attachment,
  ctx: CarryContext,
  pinned: boolean,
  blocks: string[],
  needs: Omit<BinaryNeed, "message">[]
): void {
  const r = carry(a, ctx, pinned);
  blocks.push(r.text);
  if (r.as === "image") needs.push({ kind: "image", fileIds: r.fileIds, name: a.name });
  else if (r.as === "file") needs.push({ kind: "file", fileIds: [r.fileId], name: a.name, mime: r.mime });
}

interface ChatState {
  conversation: Conversation | null;
  loading: boolean;
  /** text arriving right now, or null when idle */
  streaming: string | null;
  /** id of the turn being streamed into */
  streamingTurnId: string | null;
  /** The agent loop as it happens, or null outside agent mode. Live state
   *  only — the durable record is Variant.trace. */
  agentLive: AgentLive | null;
  busy: boolean;
  error: string | null;
  followups: string[];

  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  stop: () => void;
  regenerate: (turnId: string, override?: ModelOverride) => Promise<void>;
  editUserTurn: (turnId: string, text: string) => Promise<void>;
  retry: () => Promise<void>;
  branchFrom: (turnIndex: number) => void;
  update: (patch: Partial<Conversation>) => void;
  setContext: (sources: ContextSource[]) => void;
  clearError: () => void;
  /** Returns what it made, so a caller that writes into a brand-new thread
   *  (/map draws its mind map into one) does not have to wait for the route. */
  newConversation: (opts?: chatStore.CreateOpts, firstMessage?: string) => Conversation;
  /** The model chosen on the empty screen, before a conversation exists to
   *  pin it to. Applied when the first message lazily creates one. */
  draftModel: string;
  setDraftModel: (m: string) => void;
  draftEffort: Effort | "";
  setDraftEffort: (e: Effort | "") => void;
  /** The mode chosen on the empty screen, before a conversation exists to pin
   *  it to. Without this, picking Agent or Deep on first arrival at chat did
   *  nothing at all: `update()` returns early with no conversation, so the
   *  choice was dropped and the chip snapped back to Direct. Model and effort
   *  already had drafts for exactly this reason; mode was added without one. */
  draftMode: ChatMode;
  setDraftMode: (m: ChatMode) => void;
  /** The capability switches thrown on the empty screen. Same story as the
   *  three above and the same bug: turning Web on before typing looked like
   *  it worked, then did nothing, because `update()` has no conversation to
   *  write to and returns. The chip stayed lit off nothing at all until a
   *  thread existed to hold it. */
  draftActions: ChatActionId[];
  setDraftActions: (a: ChatActionId[]) => void;
}

const Ctx = createContext<ChatState | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const { conversationId, openChat } = useRoute();
  useSyncExternalStore(chatStore.subscribe, chatStore.getVersion, chatStore.getVersion);

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const [agentLive, setAgentLive] = useState<AgentLive | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followups, setFollowups] = useState<string[]>([]);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<Effort | "">("");
  const [draftMode, setDraftMode] = useState<ChatMode>("direct");
  const [draftActions, setDraftActions] = useState<ChatActionId[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const followupAbort = useRef<AbortController | null>(null);

  /* ---- load the routed conversation ---- */
  useEffect(() => {
    let cancelled = false;
    if (!conversationId) {
      setConversation(null);
      setFollowups([]);
      return;
    }
    const cached = chatStore.peek(conversationId);
    if (cached) {
      setConversation(cached);
      setFollowups([]);
      return;
    }
    setLoading(true);
    chatStore
      .load(conversationId)
      .then((c) => {
        if (cancelled) return;
        setConversation(c);
        setFollowups([]);
        if (!c) openChat(null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId, openChat]);

  useEffect(() => {
    void loadPricing();
    const onHide = () => chatStore.flushAll();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  /**
   * The drafts as of right now, readable from a callback of any age.
   *
   * The mirror is not defensive programming, it is a bug that was caught in
   * the browser: ChatView registers ctrl+J once and re-registers it only when
   * the palette or the drawer moves, so the `newConversation` it holds is a
   * closure from an early render. Reading the draft state directly, that
   * closure saw the values from whenever the listener was last attached —
   * always empty — and a new chat started with Web on silently started with
   * Web off. A ref has no vintage.
   */
  const draftsRef = useRef({ draftModel, draftEffort, draftMode, draftActions });
  useEffect(() => {
    draftsRef.current = { draftModel, draftEffort, draftMode, draftActions };
  }, [draftModel, draftEffort, draftMode, draftActions]);

  /**
   * What the composer was set to before there was a conversation to set it on.
   *
   * Every creation path funnels through this, which is the fix for a quieter
   * version of the same bug: `send()` applied the drafts, but the starter
   * cards and the slash commands called `newConversation()` directly, so
   * picking a model and then clicking "Quiz me on what's due" threw the choice
   * away. Explicit opts still win — a starter that asks for the Socratic
   * persona means it.
   *
   * Only non-empty drafts are emitted, so spreading this over CreateOpts never
   * overwrites a caller's field with "".
   */
  const withDrafts = useCallback((): chatStore.CreateOpts => {
    const d = draftsRef.current;
    return {
      ...(d.draftModel ? { model: d.draftModel } : {}),
      ...(d.draftEffort ? { effort: d.draftEffort } : {}),
      ...(d.draftMode !== "direct" ? { mode: d.draftMode } : {}),
      ...(d.draftActions.length ? { actions: d.draftActions } : {})
    };
  }, []);

  /** A local re-render trigger: the conversation object is mutated in place by
   *  chatStore, so React needs a nudge that is not a new reference. */
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  // Resolved through the project so a project-level backend/model default
  // (set in the project's settings scope) actually takes effect, not just
  // shows up in the UI — conversation beats project beats global.
  const override = useMemo(() => {
    if (!conversation) return undefined;
    const project = store.get().projects[conversation.projectId];
    return { backend: resolveBackend(conversation, project).value, model: resolveModel(conversation, project).value };
  }, [conversation?.backend, conversation?.model, conversation?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- assemble the wire messages ---- */
  const buildMessages = useCallback(
    (c: Conversation, upTo: number): { messages: ChatMessage[]; memories: Memory[]; binary: BinaryNeed[] } => {
      const project = store.get().projects[c.projectId];
      const effort = resolveEffort(c, project).value;
      const budget = budgetFor(effort);
      const persona = c.systemPrompt || getPersona(c.personaId).prompt;
      const lastUser = [...c.turns.slice(0, upTo + 1)].reverse().find((t) => t.role === "user");
      const queryText = lastUser ? chatStore.activeContent(lastUser) : "";
      const { system, memories } = buildContext(persona, c.context, queryText, c.projectId, budget.memoryLimit);
      const msgs: ChatMessage[] = [];
      if (system) msgs.push({ role: "system", content: system });

      /* What the model that will answer can take, asked of the model the
         conversation actually resolves to — through its project — so the
         warning the composer showed and the bytes that go out agree. */
      const target = AI.resolve({ backend: resolveBackend(c, project).value, model: resolveModel(c, project).value });
      const modalities = catalogueEntry(target.model)?.inputModalities;
      const mode = c.mode === "agent" || c.mode === "deep" ? c.mode : "direct";
      const base: Omit<CarryContext, "age"> = {
        window: windowFor(effort),
        image: canTake(modalities, "image"),
        file: canTake(modalities, "file"),
        backend: target.type,
        /* The agent loop has no way to name OpenRouter's PDF parser on its
           requests, and a file sent with none named is read by OpenRouter's
           paid default. Agent and Deep read PDFs in this browser. */
        pdfEngine: mode === "direct" ? store.settings().pdfEngine || "local" : "local"
      };

      /* How many user turns stand between each turn and the newest — what
         decides whether a picture still rides as itself. */
      const age = new Map<number, number>();
      let seen = 0;
      for (let i = Math.min(upTo, c.turns.length - 1); i >= 0; i--) {
        if (c.turns[i].role === "user") age.set(i, seen++);
      }
      const pinnedIds = new Set(c.pinnedAttachments.map((a) => a.id));
      const binary: BinaryNeed[] = [];

      /* Effort decides how far back the conversation is replayed. The window
         is counted from the newest end so the current exchange is always in
         it — truncating from the front would drop the question being asked. */
      const first = Math.max(0, Math.min(upTo, c.turns.length - 1) - budget.historyTurns + 1);
      for (let i = first; i <= upTo && i < c.turns.length; i++) {
        const t = c.turns[i];
        let content = chatStore.activeContent(t);
        const blocks: string[] = [];
        const needs: Omit<BinaryNeed, "message">[] = [];
        for (const a of t.attachments || []) {
          /* A pinned attachment rides on the newest message instead, below;
             carrying it here as well would pay for it twice. */
          if (pinnedIds.has(a.id)) continue;
          carryInto(a, { ...base, age: age.get(i) ?? 0 }, false, blocks, needs);
        }
        if (blocks.length) content = blocks.join("\n\n") + (content ? "\n\n" + content : "");
        if (!content.trim()) continue;
        for (const n of needs) binary.push({ ...n, message: msgs.length });
        msgs.push({ role: t.role, content });
      }

      /* Pinned attachments ride on the newest user message of every send —
         the thread's standing material, as a project's knowledge is the
         project's. `pinnedAttachments` was persisted and copied on branch for
         months with nothing ever reading it. */
      if (c.pinnedAttachments.length) {
        const last = msgs.map((m) => m.role).lastIndexOf("user");
        if (last >= 0) {
          const blocks: string[] = [];
          const needs: Omit<BinaryNeed, "message">[] = [];
          for (const a of c.pinnedAttachments) carryInto(a, { ...base, age: 0 }, true, blocks, needs);
          msgs[last] = { ...msgs[last], content: blocks.join("\n\n") + "\n\n" + msgs[last].content };
          for (const n of needs) binary.push({ ...n, message: last });
        }
      }
      /* Only the newest version of a canvas carries its code; the ones it
         replaced become a line saying so. A thread that revised one four times
         would otherwise send all four on every message after. */
      const collapsed = collapseCanvases(msgs.map((m) => m.content));
      for (let i = 0; i < msgs.length; i++) {
        if (collapsed[i] !== msgs[i].content) msgs[i] = { ...msgs[i], content: collapsed[i] };
      }

      return { messages: msgs, memories, binary };
    },
    []
  );

  /* ---- the one place a request is actually made ---- */
  const run = useCallback(
    async (c: Conversation, targetTurn: Turn, upToIndex: number, override?: ModelOverride) => {
      // A regenerate can ask for a different model without pinning the
      // conversation to it — c.backend/c.model stay untouched either way.
      const runBackend = override?.backend ?? c.backend;
      const runModel = override?.model ?? c.model;
      const controller = new AbortController();
      abortRef.current = controller;
      followupAbort.current?.abort();
      setFollowups([]);
      setBusy(true);
      setError(null);
      setStreaming("");
      setStreamingTurnId(targetTurn.id);

      const started = Date.now();
      let usage: Usage | undefined;
      let citations: Citation[] | undefined;
      let acc = "";

      // Build the prompt once and record usage against exactly what went into
      // it. Retrieval used to run twice — once here for telemetry, once inside
      // buildMessages for the prompt — with recordUsage moving useCount in
      // between, so the two passes could pick different memories and the
      // telemetry described a prompt that was never sent.
      //
      // Only run() makes the primary reply call. The cheaper maybeFollowups()
      // below reuses buildMessages too, but a suggestion request isn't what
      // "used" should mean here, so it does not record.
      const built = buildMessages(c, upToIndex);
      for (const m of built.memories) memoryStore.recordUsage(m.id);
      const budget = budgetFor(resolveEffort(c, store.get().projects[c.projectId]).value);
      const replyScale = budget.replyScale;

      /* Agent mode is a different shape of request, not a different feature:
         same turn, same variants, same abort path, same receipts. Everything
         after this branch is shared, which is why the loop returns an answer
         string rather than writing the turn itself. */
      let trace: AgentTrace | undefined;
      let agentProposed: NonNullable<Variant["agentProposed"]> | undefined;

      try {
        /* Pictures and files are read out of the file store here, at send
           time, rather than inside buildMessages — that also runs for
           follow-up suggestions, which never carry bytes. */
        const messages = await hydrate(built.messages, built.binary);
        const engine = store.settings().pdfEngine;
        const pdfEngine = built.binary.some((b) => b.kind === "file") && engine && engine !== "local" ? engine : undefined;
        let full: string;
        const mode = c.mode === "agent" || c.mode === "deep" ? c.mode : "direct";
        if (mode !== "direct") {
          const resolved = AI.resolve({ backend: runBackend, model: runModel });
          setAgentLive({ steps: [], answering: false, plan: null, notes: [] });
          const result = await runAgentTurn({
            /* messages[0] is the system message buildMessages already built —
               persona plus the deterministic context block. The loop keeps it:
               fixed context is cheaper than a tool call, so anything reliably
               worth knowing should already be in there. */
            system: messages[0]?.role === "system" ? messages[0].content : "",
            history: messages.filter((m) => m.role !== "system"),
            projectId: c.projectId,
            conversationId: c.id,
            turnId: targetTurn.id,
            backend: resolved.type,
            /* Shared with the mode picker via lib/effort, so the number shown
               on the chip is the number the loop actually gets. */
            maxSteps: mode === "deep" ? deepSteps(budget.agentSteps) : budget.agentSteps,
            planning: mode === "deep",
            inProject: !!store.get().projects[c.projectId],
            /* Writes follow the same policy every other surface obeys. A
               project on `manual` gets a read-only assistant rather than one
               that fills a tray nobody asked for. */
            allowWrites: (store.get().projects[c.projectId]?.memoryPolicy?.autonomy || store.settings().autonomy) !== "manual",
            temperature: c.temperature,
            maxTokens: Math.max(256, Math.round(c.maxTokens * replyScale)),
            signal: controller.signal,
            override: { backend: runBackend, model: runModel },
            onEvent: (e) => {
              if (e.kind === "token") {
                acc = e.acc;
                setStreaming(e.acc);
              } else if (e.kind === "thought") {
                setAgentLive((s) => (s ? patchStep(s, e.step, (st) => ({ ...st, thought: e.text })) : s));
              } else if (e.kind === "calling") {
                /* What streamed during this round was intent, not answer. Drop
                   it from the reply body — it reappears as the step's thought
                   in the trace, which is where a "let me check three things"
                   belongs. */
                acc = "";
                setStreaming("");
                setAgentLive((s) => (s ? patchStep(s, e.step, (st) => ({ ...st, calls: [...st.calls, e.call] })) : s));
              } else if (e.kind === "called") {
                setAgentLive((s) => (s ? patchStep(s, e.step, (st) => ({ ...st, runs: [...st.runs, e.run] })) : s));
              } else if (e.kind === "plan") {
                /* Cloned on the way in: the plan tools mutate their own object
                   in the run scratch, so storing it by reference would give
                   React the same object every time and nothing would re-render. */
                setAgentLive((s) => (s ? { ...s, plan: { goal: e.plan.goal, items: e.plan.items.map((i) => ({ ...i })) } } : s));
              } else if (e.kind === "note") {
                setAgentLive((s) => (s ? { ...s, notes: [...s.notes, e.text] } : s));
              } else if (e.kind === "answering") {
                setAgentLive((s) => (s ? { ...s, answering: true } : s));
              }
            }
          });
          full = result.answer;
          trace = result.trace;
          if (result.proposed.length) agentProposed = result.proposed;
          usage = {
            ...result.usage,
            cost: result.usage.reportedCost ?? costOf(result.usage, priceForModel(resolved.type, runModel))
          };
        } else
        full = await AI.chat(
          messages,
          {
            temperature: c.temperature,
            maxTokens: Math.max(256, Math.round(c.maxTokens * replyScale)),
            signal: controller.signal,
            label: "chat",
            actions: c.actions,
            pdfEngine,
            onToken: (_t, a) => {
              acc = a;
              setStreaming(a);
            },
            onCitations: (cs) => {
              citations = cs;
            },
            onUsage: (u) => {
              /* What the provider says it charged beats what we can
                 reconstruct: it is the real figure, and it includes web
                 search fees that tokens-times-price cannot see. */
              /* Priced through the same function the usage ledger uses, and
                 through the *resolved* backend rather than the conversation's
                 raw one — runBackend is "" whenever the thread inherits. The
                 two used to disagree: this line looked the model up in the
                 catalogue regardless of where the call actually went, so a
                 local or free backend reported a cost it never charged. */
              usage = { ...u, cost: u.reportedCost ?? costOf(u, priceForModel(AI.resolve({ backend: runBackend, model: runModel }).type, runModel)) };
            }
          },
          { backend: runBackend, model: runModel }
        );

        const raw = full || acc;
        if (!raw.trim()) throw new Error("The model returned an empty reply.");

        /* Pull any save-to-memory block out of the markdown *before* it is
           stored or rendered. Stripping rendered HTML instead would be an
           injection bug waiting to happen. */
        const { cleaned, items } = memoryCapture.parseReply(raw);
        const content = cleaned || raw;

        let saved;
        if (items) {
          const result = memoryCapture.capture(items, { conversationId: c.id, turnId: targetTurn.id });
          memoryCapture.logToJournal(result, "Saved from chat");
          saved = memoryCapture.summarise(result);
        }

        targetTurn.variants.push({
          content,
          model: runModel,
          usage,
          elapsed: Date.now() - started,
          createdAt: Date.now(),
          saved,
          citations,
          trace,
          agentProposed
        });
        targetTurn.active = targetTurn.variants.length - 1;
        targetTurn.error = undefined;
        chatStore.addUsageTo(c, usage);
        chatStore.persist(c, true);

        void maybeTitle(c);
        /* The one extra request per message, and the reason a single send
           used to look like two. Gated twice on purpose: turned off wholesale
           in Settings, and skipped at low effort regardless. */
        if (budget.followups && store.settings().followups) void maybeFollowups(c);
      } catch (e) {
        if (isAbort(e)) {
          // Keep whatever streamed in before the stop — half an explanation is
          // still worth reading, and discarding it would be hostile.
          if (acc.trim()) {
            targetTurn.variants.push({
              content: acc,
              model: runModel,
              elapsed: Date.now() - started,
              createdAt: Date.now(),
              /* Whatever the loop got through before the stop is still the
                 honest account of how that half-answer was reached. */
              trace
            });
            targetTurn.active = targetTurn.variants.length - 1;
            chatStore.persist(c, true);
          } else {
            chatStore.removeTurn(c, targetTurn.id);
          }
        } else {
          const msg = (e as Error).message || "Request failed";
          /* Whatever streamed in before it broke is kept, exactly as it is on
             the abort path — "half an explanation is still worth reading" is
             not less true when the connection dropped than when you pressed
             stop, and this branch is the one that actually happens. A stream
             that dies four paragraphs into an answer used to lose all four
             and show a red box.

             The error rides *with* the variant rather than instead of it, so
             the turn renders the partial reply and says underneath that it
             was cut off. Retry replaces the turn, so nothing is orphaned. */
          if (acc.trim()) {
            targetTurn.variants.push({
              content: acc,
              model: runModel,
              usage,
              elapsed: Date.now() - started,
              createdAt: Date.now(),
              trace,
              citations
            });
            targetTurn.active = targetTurn.variants.length - 1;
          }
          targetTurn.error = msg;
          setError(msg);
          chatStore.persist(c, true);
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setStreaming(null);
        setStreamingTurnId(null);
        setAgentLive(null);
        rerender();
      }
    },
    [buildMessages, rerender]
  );

  /* ---- auto-title after the first exchange ----

     Exactly one attempt, ever. The guard used to be `c.titled`, which is only
     set when a title comes back, so a model that returned nothing usable —
     routine once a reasoning scratchpad meets a small token cap — left the
     thread untitled and this ran again on the next message, and the next.
     That is the "one direct message, two requests" bug: the second request
     was this, firing forever.

     So the flag now records *that we asked*, not that it worked, and a reply
     with no title in it falls back to a title written from the opening
     message locally. Which is also the whole mechanism when auto-titling is
     off: the thread still gets a name, it just costs nothing. */
  const maybeTitle = useCallback(
    async (c: Conversation) => {
      if (c.titled || c.turns.length < 2) return;
      const firstUser = c.turns.find((t) => t.role === "user");
      const firstAsst = c.turns.find((t) => t.role === "assistant");
      if (!firstUser || !firstAsst) return;

      // Claimed before the await, so a second reply landing while this call is
      // still in flight cannot start a third request for the same title.
      c.titled = true;

      let title = "";
      if (store.settings().autoTitle) {
        try {
          title = await AI.generateTitle(chatStore.activeContent(firstUser), chatStore.activeContent(firstAsst), {
            backend: c.backend,
            model: c.model
          });
        } catch {
          /* an unnamed conversation is a cosmetic problem, not a failure */
        }
      }
      if (!title) title = localTitle(chatStore.activeContent(firstUser));

      // No text to name it after (an attachment sent alone) keeps the
      // placeholder, and the flag still stands: asking again would not help.
      if (title) c.title = title;
      chatStore.persist(c, true);
      rerender();
    },
    [rerender]
  );

  const maybeFollowups = useCallback(
    async (c: Conversation) => {
      const controller = new AbortController();
      followupAbort.current = controller;
      const out = await AI.suggestFollowups(
        buildMessages(c, c.turns.length - 1).messages,
        { backend: c.backend, model: c.model },
        controller.signal
      );
      if (!controller.signal.aborted) setFollowups(out);
    },
    [buildMessages]
  );

  /* ---------------------------------------------------------------- API -- */

  const send = useCallback(
    async (text: string, attachments?: Attachment[]) => {
      /* The composer disables its button while a reply streams, but send() is
         also reached from starters, slash commands, follow-up chips and the
         command palette — and a second run() would overwrite abortRef with
         its own controller, leaving the first request live with nothing able
         to stop it, both of them writing variants and both fighting over the
         streaming buffer. The guard belongs here, next to the state it
         protects, not in each of the six callers. */
      if (busy) return;

      let c = conversation;
      if (!c) {
        // A model picked on the empty screen has to survive the conversation
        // being created here, or choosing one before typing does nothing.
        c = chatStore.create(withDrafts());
        setConversation(c);
        openChat(c.id);
      }
      const body = text.trim();
      if (!body && !attachments?.length) return;

      /* A pinned attachment is kept on the conversation as well as on its
         turn: the turn records when it was sent, the conversation is what
         keeps it in front of the model on every message after. */
      const pinned = (attachments || []).filter((a) => a.pinned);
      if (pinned.length) {
        const have = new Set(c.pinnedAttachments.map((a) => a.id));
        c.pinnedAttachments = [...c.pinnedAttachments, ...pinned.filter((a) => !have.has(a.id))];
      }
      chatStore.addTurn(c, chatStore.makeTurn("user", body, attachments));
      const assistant = blankAssistantTurn();
      c.turns.push(assistant);
      chatStore.persist(c);
      rerender();

      await run(c, assistant, c.turns.length - 2);
    },
    [busy, conversation, openChat, run, rerender, withDrafts]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const regenerate = useCallback(
    async (turnId: string, override?: ModelOverride) => {
      const c = conversation;
      if (!c || busy) return;
      const idx = c.turns.findIndex((t) => t.id === turnId);
      if (idx < 0) return;
      const turn = c.turns[idx];
      if (turn.role !== "assistant") return;
      // Anything after this reply was a response to it, so it no longer holds.
      if (idx < c.turns.length - 1) chatStore.truncateAfter(c, idx);
      await run(c, turn, idx - 1, override);
    },
    [conversation, busy, run]
  );

  const editUserTurn = useCallback(
    async (turnId: string, text: string) => {
      const c = conversation;
      if (!c || busy) return;
      const idx = c.turns.findIndex((t) => t.id === turnId);
      if (idx < 0) return;
      const turn = c.turns[idx];
      turn.variants.push({ content: text, createdAt: Date.now() });
      turn.active = turn.variants.length - 1;
      chatStore.truncateAfter(c, idx);

      const assistant = blankAssistantTurn();
      c.turns.push(assistant);
      chatStore.persist(c);
      rerender();
      await run(c, assistant, c.turns.length - 2);
    },
    [conversation, busy, run, rerender]
  );

  const retry = useCallback(async () => {
    const c = conversation;
    if (!c || busy) return;
    const last = c.turns[c.turns.length - 1];
    if (!last || last.role !== "assistant") return;
    await run(c, last, c.turns.length - 2);
  }, [conversation, busy, run]);

  const branchFrom = useCallback(
    (turnIndex: number) => {
      const c = conversation;
      if (!c) return;
      const copy = chatStore.branch(c, turnIndex);
      openChat(copy.id);
    },
    [conversation, openChat]
  );

  const update = useCallback(
    (patch: Partial<Conversation>) => {
      const c = conversation;
      if (!c) return;
      Object.assign(c, patch);
      chatStore.persist(c, true);
      rerender();
    },
    [conversation, rerender]
  );

  const setContext = useCallback((sources: ContextSource[]) => update({ context: sources }), [update]);

  const newConversation = useCallback(
    (opts?: chatStore.CreateOpts, firstMessage?: string) => {
      const c = chatStore.create({ ...withDrafts(), ...opts });
      setConversation(c);
      openChat(c.id);
      if (firstMessage) {
        // Defer so the route and conversation are settled before sending.
        setTimeout(() => {
          chatStore.addTurn(c, chatStore.makeTurn("user", firstMessage));
          const assistant: Turn = {
            id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()),
            role: "assistant",
            variants: [],
            active: 0,
            createdAt: Date.now()
          };
          c.turns.push(assistant);
          chatStore.persist(c);
          void run(c, assistant, c.turns.length - 2);
        }, 0);
      }
      return c;
    },
    [openChat, run, withDrafts]
  );

  const value: ChatState = {
    conversation,
    loading,
    streaming,
    streamingTurnId,
    agentLive,
    busy,
    error,
    followups,
    send,
    stop,
    regenerate,
    editUserTurn,
    retry,
    branchFrom,
    update,
    setContext,
    clearError: () => setError(null),
    newConversation,
    draftModel,
    setDraftModel,
    draftEffort,
    setDraftEffort,
    draftMode,
    setDraftMode,
    draftActions,
    setDraftActions
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChat(): ChatState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

/** Settings is one surface opened from all six sections, and one of its
 *  categories — "This chat" — is only meaningful inside chat. This is how it
 *  asks whether it is there, rather than being offered in every view and
 *  throwing in five of them. */
export function useMaybeChat(): ChatState | null {
  return useContext(Ctx);
}
