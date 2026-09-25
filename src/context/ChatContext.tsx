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
  type ReactNode,
  type Dispatch,
  type SetStateAction
} from "react";
import * as U from "@/lib/util";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import * as memoryStore from "@/services/memoryStore";
import * as memoryCapture from "@/services/memoryCapture";
import { keepGenerated } from "@/services/files/generated";
import * as AI from "@/services/ai";
import { isAbort } from "@/services/ai/backends";
import { catalogueEntry, imageCaps, loadPricing, loadVideoCaps, priceForModel, videoCaps } from "@/services/pricing";
import { keepVideo } from "@/services/files/generatedVideo";
import { clock, effectiveVideo } from "@/lib/videoSpec";
import { buildContext } from "@/lib/chatContext";
import { getPersona } from "@/lib/personas";
import { budgetFor, deepSteps } from "@/lib/effort";
import { localTitle } from "@/lib/title";
import type { Effort } from "@/types/core";
import { costOf } from "@/lib/tokens";
import { resolveBackend, resolveEffort, resolveModel } from "@/lib/resolveSetting";
import { useRoute } from "./RouteContext";
import type { Attachment, ChatMode, Conversation, ContextSource, GeneratedVideo, Turn, Usage, Variant, VideoJob, VideoSpec } from "@/types/chat";
import { runAgentTurn } from "@/services/agent";
import { TOOL_WORDS } from "@/services/agent/tools";
import { dataUrlsOf, hydrate, type BinaryNeed } from "@/services/files/wire";
import * as drawing from "@/services/drawing";
import { canTake } from "@/lib/modality";
import { carry, windowFor, type CarryContext } from "@/lib/files/carry";
import { collapseCanvases } from "@/lib/visuals/artifacts";
import type { AgentPlan, AgentTrace, ToolCall, ToolRun } from "@/types/agent";
import type { ChatActionId } from "@/lib/chatActions";
import type { BackendType, ChatMessage, Citation, Memory } from "@/types";
import { capReasoning } from "@/lib/reasoning";
import { DEFAULT_IMAGE_SPEC, type ImageSpec } from "@/lib/imageSpec";
import { actionsFor, availability } from "@/lib/chatActions";
import { voiceBrief, voiceMaxTokens } from "@/lib/voice/style";
import type { VoiceStyle } from "@/types";

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
  /** What the model worked through before this round's calls, when the
   *  provider sends it. Live only: the saved trace keeps the calls and their
   *  results, which is the auditable half. */
  reasoning?: string;
}

export interface AgentLive {
  steps: LiveStep[];
  answering: boolean;
  /** Deep mode's plan, updated in place as steps close. */
  plan: AgentPlan | null;
  notes: string[];
}

/**
 * The model thinking, right now.
 *
 * Three states fall out of two fields, which is why there is no `kind` here:
 * text arriving is the chain itself; `asked` with no text and no answer yet is
 * a model that thinks behind a curtain; neither is an ordinary reply. Only the
 * first two put anything on screen, and lib/reasoning.ts does the phrasing.
 *
 * Live state only — the durable half is Variant.reasoning, written once when
 * the reply lands, exactly as AgentLive relates to Variant.trace.
 */
export interface ThinkingLive {
  /** The chain so far, or "" when the provider hides it. */
  text: string;
  /** When the request went out. */
  startedAt: number;
  /** Set by the first answer token: from here on it is writing, not thinking. */
  endedAt: number | null;
  /** The Think action was on for this send, so a silent gap before the first
   *  answer token is the model working rather than the network being slow.
   *  Without this the opaque case — a model that reasons and shows nothing —
   *  would be indistinguishable from a slow connection. */
  asked: boolean;
}

/** What voice mode is told while a spoken turn is being answered — which of
 *  the things it could do, it is doing. Tied to the loop's real events, never
 *  to a timer, so the voice bar cannot claim work that is not happening. */
export type VoiceStatus =
  | { kind: "answering" }
  /** `label` is the tool as a person says it — "Checking your reviews". */
  | { kind: "tool"; name: string; label: string }
  | { kind: "plan"; done: number; total: number };

/**
 * A turn said out loud, and the hooks voice mode listens on while it is
 * answered. Passed to send() by services/voice through ChatView; everything
 * else about the turn — the history, the context, the tools, the receipts —
 * is the ordinary path, which is the point.
 */
export interface VoiceTurn {
  style: VoiceStyle;
  /** The assistant turn being answered into, as soon as it exists. */
  onStart(turnId: string): void;
  /** The reply so far. Empty again when the loop throws a round away to
   *  call a tool — lib/voice/chunker.ts reads that as a new run. */
  onText(acc: string): void;
  onStatus(s: VoiceStatus): void;
  /** The reply is complete, stopped, or failed. */
  onDone(r: { ok: boolean; error?: string }): void;
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
  /** The model's working as it arrives, or null when nothing is in flight. */
  thinking: ThinkingLive | null;
  busy: boolean;
  error: string | null;
  followups: string[];

  /** `voice` makes it a spoken turn: answered through the voice route, shaped
   *  for listening, and reported back through the hooks as it streams. */
  send: (text: string, attachments?: Attachment[], voice?: VoiceTurn) => Promise<void>;
  stop: () => void;
  /** Voice mode was talked over: cut this reply back to what was heard. Safe
   *  to call while the reply is still arriving — the cut waits for it. */
  cutReply: (turnId: string, text: string) => void;
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
  /** The picture's shape and size chosen on the empty screen. A draft for the
   *  reason every control above has one: `update()` returns early with no
   *  conversation, so without this, picking Wide before typing the first
   *  message would silently draw a square. */
  draftImage: ImageSpec;
  setDraftImage: (s: ImageSpec) => void;
  /** Video mode's dials before the thread exists, for the reason every draft
   *  here exists: update() returns early with no conversation. */
  draftVideo: VideoSpec;
  setDraftVideo: Dispatch<SetStateAction<VideoSpec>>;
}

const Ctx = createContext<ChatState | null>(null);

/** A clip the model could not make — as opposed to one this tab lost touch
 *  with. The difference decides whether Retry asks again or waits again. */
class ClipFailed extends Error {}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Wait for a clip, then fetch it. Polls often at first and then less —
 * a clip takes minutes, and a request every four seconds for five minutes is
 * seventy-five requests saying "not yet". A dropped connection is tried again
 * a few times before it is reported, because a phone changing networks
 * mid-wait is the ordinary case. Gives up after forty-five minutes, with the
 * job kept so the wait can be resumed.
 */
async function waitForClip(
  job: VideoJob,
  signal: AbortSignal,
  tick: (elapsedMs: number) => void
): Promise<{ blob: Blob; cost?: number }> {
  let delay = 4000;
  let misses = 0;
  for (;;) {
    tick(Date.now() - job.startedAt);
    let poll;
    try {
      poll = await AI.checkVideo(job.id, job.model, signal);
      misses = 0;
    } catch (e) {
      if (isAbort(e)) throw e;
      if (++misses >= 4) throw e;
      await pause(delay, signal);
      continue;
    }
    if (poll.status === "completed") {
      const url = poll.urls[0];
      if (!url) throw new ClipFailed("The clip finished but OpenRouter gave no file to fetch.");
      return { blob: await AI.fetchVideo(url, job.model, signal), cost: poll.cost };
    }
    if (poll.status === "failed" || poll.status === "cancelled" || poll.status === "expired") {
      throw new ClipFailed(poll.error ? `The clip could not be made — ${poll.error}` : "The clip could not be made.");
    }
    if (Date.now() - job.startedAt > 45 * 60 * 1000) {
      throw new Error("The clip is still not finished after forty-five minutes.");
    }
    await pause(delay, signal);
    delay = Math.min(15000, Math.round(delay * 1.35));
  }
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { conversationId, openChat } = useRoute();
  useSyncExternalStore(chatStore.subscribe, chatStore.getVersion, chatStore.getVersion);

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const [agentLive, setAgentLive] = useState<AgentLive | null>(null);
  const [thinking, setThinking] = useState<ThinkingLive | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followups, setFollowups] = useState<string[]>([]);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<Effort | "">("");
  const [draftMode, setDraftMode] = useState<ChatMode>("direct");
  const [draftActions, setDraftActions] = useState<ChatActionId[]>([]);
  const [draftImage, setDraftImage] = useState<ImageSpec>(DEFAULT_IMAGE_SPEC);
  const [draftVideo, setDraftVideo] = useState<VideoSpec>({});

  const abortRef = useRef<AbortController | null>(null);
  const followupAbort = useRef<AbortController | null>(null);
  /* `busy` and `conversation` as of this instant, not as of the render a
     callback was made in. Voice mode sends the next turn the moment the
     previous one is stopped, from a closure that can be several renders old:
     reading the state there saw a request still running and dropped the turn,
     or saw no conversation yet and created a second one. */
  const busyRef = useRef(false);
  const convRef = useRef<Conversation | null>(null);
  convRef.current = conversation;
  /** Interrupted replies waiting to be cut once their text has landed. */
  const pendingCuts = useRef(new Map<string, string>());

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
  const draftsRef = useRef({ draftModel, draftEffort, draftMode, draftActions, draftImage, draftVideo });
  useEffect(() => {
    draftsRef.current = { draftModel, draftEffort, draftMode, draftActions, draftImage, draftVideo };
  }, [draftModel, draftEffort, draftMode, draftActions, draftImage, draftVideo]);

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
      ...(d.draftActions.length ? { actions: d.draftActions } : {}),
      /* Only when it says something. A spec of two Autos is the absence of a
         spec, and writing it would put a field on every conversation ever
         created from this screen. */
      ...(d.draftImage.aspect !== "auto" || d.draftImage.size !== "auto" || d.draftImage.chain === false ? { image: d.draftImage } : {}),
      ...(Object.keys(d.draftVideo).length ? { video: d.draftVideo } : {})
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
    (c: Conversation, upTo: number, voice?: VoiceStyle): { messages: ChatMessage[]; memories: Memory[]; binary: BinaryNeed[] } => {
      const project = store.get().projects[c.projectId];
      const effort = resolveEffort(c, project).value;
      const budget = budgetFor(effort);
      const persona = c.systemPrompt || getPersona(c.personaId).prompt;
      const lastUser = [...c.turns.slice(0, upTo + 1)].reverse().find((t) => t.role === "user");
      const queryText = lastUser ? chatStore.activeContent(lastUser) : "";
      const built = buildContext(persona, c.context, queryText, c.projectId, budget.memoryLimit, c.id);
      const memories = built.memories;
      /* Last, so that "only words" outranks the figure protocol above it when
         the two disagree — see lib/voice/style.ts. */
      const system = voice ? (built.system ? built.system + "\n\n" : "") + voiceBrief(voice) : built.system;
      const msgs: ChatMessage[] = [];
      if (system) msgs.push({ role: "system", content: system });

      /* What the model that will answer can take, asked of the model the
         conversation actually resolves to — through its project — so the
         warning the composer showed and the bytes that go out agree. */
      const target = AI.resolve({ backend: resolveBackend(c, project).value, model: resolveModel(c, project).value });
      const modalities = catalogueEntry(target.model)?.inputModalities;
      /* A voice turn is answered by the loop whatever the thread's own mode. */
      const mode = voice ? "agent" : c.mode === "agent" || c.mode === "deep" ? c.mode : "direct";
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
  /** Apply a waiting cut to a reply whose text has landed. The words it had
   *  written are kept on the variant, so nothing is lost — only what the next
   *  request replays changes. */
  const applyCut = useCallback((c: Conversation, turn: Turn) => {
    const text = pendingCuts.current.get(turn.id);
    const v = turn.variants[turn.active];
    if (text == null || !v) return;
    pendingCuts.current.delete(turn.id);
    if (v.content.trim() === text.trim()) return;
    v.interrupted = { full: v.interrupted?.full ?? v.content };
    v.content = text;
    chatStore.persist(c, true);
  }, []);

  const run = useCallback(
    async (c: Conversation, targetTurn: Turn, upToIndex: number, override?: ModelOverride, voice?: VoiceTurn) => {
      // A regenerate can ask for a different model without pinning the
      // conversation to it — c.backend/c.model stay untouched either way.
      // A voice turn may be answered by a model set for talking, in
      // Settings → Voice, without the thread being pinned to it.
      const runBackend = override?.backend ?? c.backend;
      const runModel = override?.model ?? ((voice && store.settings().talk.model) || c.model);
      const controller = new AbortController();
      abortRef.current = controller;
      busyRef.current = true;
      voice?.onStart(targetTurn.id);
      let outcome: { ok: boolean; error?: string } = { ok: true };
      followupAbort.current?.abort();
      setFollowups([]);
      setBusy(true);
      setError(null);
      setStreaming("");
      setStreamingTurnId(targetTurn.id);

      const started = Date.now();
      /* Seeded before the request rather than on the first reasoning chunk, so
         the panel can start counting from when the model got the question. A
         chain that arrives four seconds in did not take zero seconds to
         produce, and a counter that starts at the first chunk would say it
         did. */
      setThinking({ text: "", startedAt: started, endedAt: null, asked: (c.actions || []).includes("think") });
      /* Kept outside React state as well: setState is async and batched, and
         the variant written at the end of this function needs the final chain,
         not whatever the last render happened to see. */
      let chain = "";
      let reasoned = false;
      let thoughtUntil: number | null = null;
      /** The first answer token ends thinking. Idempotent — every token calls
       *  it and only the first one means anything. */
      const answerStarted = () => {
        if (thoughtUntil != null) return;
        thoughtUntil = Date.now();
        setThinking((t) => (t ? { ...t, endedAt: thoughtUntil } : t));
      };
      let usage: Usage | undefined;
      let citations: Citation[] | undefined;
      /* Data URLs, briefly. They are in the file store before the variant is
         written — see keepGenerated. */
      let drawn: string[] = [];
      /* A clip, once it is in the file store. */
      let videos: GeneratedVideo[] = [];
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
      const built = buildMessages(c, upToIndex, voice?.style);
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
        /* Image mode draws on one of two routes, decided by the model — see
           services/drawing.ts. Decided before the request is built, because
           the chat route is also told about the last picture. */
        const drawModel = c.mode === "image" ? AI.resolve({ backend: runBackend, model: runModel }).model : "";
        const drawRoute = c.mode === "image" && !voice ? await drawing.routeFor(drawModel) : "chat";
        const spec = c.mode === "image" ? c.image || DEFAULT_IMAGE_SPEC : undefined;
        if (c.mode === "image" && drawRoute === "chat" && drawing.chaining(spec) && canTake(catalogueEntry(drawModel)?.inputModalities, "image")) {
          /* The thread's last picture rides on the newest message, so an edit
             is an edit: the chat route replays the words of a thread, never
             its pictures, and "now make it bluer" was drawn from nothing. */
          const last = drawing.lastPicture(c, upToIndex);
          const at = built.messages.map((m) => m.role).lastIndexOf("user");
          if (last && at >= 0) built.binary.push({ message: at, kind: "image", fileIds: [last], name: "the last picture" });
        }
        /* Pictures and files are read out of the file store here, at send
           time, rather than inside buildMessages — that also runs for
           follow-up suggestions, which never carry bytes. */
        const messages = await hydrate(built.messages, built.binary);
        const engine = store.settings().pdfEngine;
        const pdfEngine = built.binary.some((b) => b.kind === "file") && engine && engine !== "local" ? engine : undefined;
        let full: string;
        /* Voice is its own route: always the loop, planning offered rather
           than required, the web a tool rather than a switch. Whoever is
           talking never picks a mode — see services/agent/prompt.ts. */
        const mode = voice ? "voice" : c.mode === "agent" || c.mode === "deep" ? c.mode : "direct";
        const threadMax = Math.max(256, Math.round(c.maxTokens * replyScale));
        if (c.mode === "video" && !voice) {
          /* A clip is a job, not a request: submitted, then waited on. The job
             is written onto the turn before any waiting starts, so a closed tab
             or a reload picks the same clip back up (see the resume effect
             below) — it is running on OpenRouter either way, and asking again
             would pay for it twice. */
          const model = AI.resolve({ backend: runBackend, model: runModel }).model;
          await loadVideoCaps();
          let job = targetTurn.videoJob;
          if (!job) {
            const caps = videoCaps(model);
            const asked = effectiveVideo(c.video, caps);
            const pics = drawing.attachedPictures(c, upToIndex).slice(0, 1);
            const canStart = !caps || !!caps.frames?.includes("first_frame");
            const firstFrame = canStart && pics.length ? (await dataUrlsOf(pics))[0] : undefined;
            const prompt = drawing.promptFor(c, upToIndex);
            const made = await AI.startVideo({ model, prompt, ...asked, firstFrame, signal: controller.signal });
            job = { id: made.id, model, prompt, asked, fromImage: !!firstFrame, startedAt: Date.now() };
            targetTurn.videoJob = job;
            chatStore.persist(c, true);
          }
          const title = catalogueEntry(job.model)?.title || job.model;
          const clip = await waitForClip(job, controller.signal, (elapsed) =>
            setStreaming(
              `*Making a${job!.asked.seconds ? ` ${job!.asked.seconds}-second` : ""} clip with ${title} — ${clock(elapsed)}.* ` +
                "Clips usually take one to five minutes. You can leave this thread or close the tab — it keeps going, and picks up here when you come back."
            )
          );
          answerStarted();
          const kept = await keepVideo(clip.blob, job.prompt, job.asked);
          if (!kept) throw new Error("The clip was made, but this browser would not store it — see the warning at the top of the page.");
          videos = [kept];
          full = "";
          usage = { promptTokens: 0, completionTokens: 0, reportedCost: clip.cost, cost: clip.cost };
          AI.meterVideo(job.model, clip.cost, kept.seconds, false);
          targetTurn.videoJob = undefined;
        } else if (drawRoute === "images") {
          /* A model that only draws: the Images API, one prompt and its
             references in, pictures out. Only dials the model's listing says
             it takes are sent — the composer shows only those, and a value it
             does not take is a 400, not a picture. */
          const caps = imageCaps(drawModel);
          const refs = await dataUrlsOf(drawing.referencesFor(c, upToIndex, spec, caps));
          const aspect = spec && spec.aspect !== "auto" && (!caps?.aspects || caps.aspects.includes(spec.aspect)) ? spec.aspect : undefined;
          const resolution = spec && spec.size !== "auto" && (!caps || caps.resolutions?.includes(spec.size)) ? spec.size : undefined;
          const out = await AI.draw({
            model: drawModel,
            prompt: drawing.promptFor(c, upToIndex),
            aspect,
            resolution,
            refs,
            signal: controller.signal
          });
          answerStarted();
          drawn = out.images;
          full = "";
          usage = { promptTokens: 0, completionTokens: 0, reportedCost: out.cost, cost: out.cost };
        } else if (mode !== "direct") {
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
               on the chip is the number the loop actually gets. Voice gets
               Deep's ceiling, and a plain answer uses none of it. */
            maxSteps: mode === "agent" ? budget.agentSteps : deepSteps(budget.agentSteps),
            planning: mode === "voice" ? "auto" : mode === "deep",
            /* Asked of the same call the send path filters Web on, so voice
               never offers a search the backend would refuse. */
            web: mode === "voice" && availability("web", resolved.backend.supports, resolved.model).can,
            onCitations: (cs) => {
              citations = cs;
            },
            inProject: !!store.get().projects[c.projectId],
            /* Writes follow the same policy every other surface obeys. A
               project on `manual` gets a read-only assistant rather than one
               that fills a tray nobody asked for. */
            allowWrites: (store.get().projects[c.projectId]?.memoryPolicy?.autonomy || store.settings().autonomy) !== "manual",
            temperature: c.temperature,
            maxTokens: voice ? voiceMaxTokens(voice.style, threadMax) : threadMax,
            signal: controller.signal,
            override: { backend: runBackend, model: runModel },
            onEvent: (e) => {
              if (e.kind === "token") {
                acc = e.acc;
                setStreaming(e.acc);
                voice?.onText(e.acc);
              } else if (e.kind === "reasoning") {
                reasoned = true;
                /* The loop's rounds each reason separately, so the durable
                   chain is the last round's — the one that produced the
                   answer. The earlier rounds stay on their steps in the live
                   trace, where they belong next to the lookups they explain. */
                chain = e.acc;
                setAgentLive((st) => (st ? patchStep(st, e.step, (x) => ({ ...x, reasoning: e.acc })) : st));
              } else if (e.kind === "thought") {
                setAgentLive((s) => (s ? patchStep(s, e.step, (st) => ({ ...st, thought: e.text })) : s));
              } else if (e.kind === "calling") {
                /* What streamed during this round was intent, not answer. Drop
                   it from the reply body — it reappears as the step's thought
                   in the trace, which is where a "let me check three things"
                   belongs. */
                acc = "";
                setStreaming("");
                voice?.onText("");
                voice?.onStatus({ kind: "tool", name: e.call.name, label: TOOL_WORDS[e.call.name]?.doing || "Looking something up" });
                setAgentLive((s) => (s ? patchStep(s, e.step, (st) => ({ ...st, calls: [...st.calls, e.call] })) : s));
              } else if (e.kind === "called") {
                setAgentLive((s) => (s ? patchStep(s, e.step, (st) => ({ ...st, runs: [...st.runs, e.run] })) : s));
              } else if (e.kind === "plan") {
                /* Cloned on the way in: the plan tools mutate their own object
                   in the run scratch, so storing it by reference would give
                   React the same object every time and nothing would re-render. */
                setAgentLive((s) => (s ? { ...s, plan: { goal: e.plan.goal, items: e.plan.items.map((i) => ({ ...i })) } } : s));
                voice?.onStatus({
                  kind: "plan",
                  done: e.plan.items.filter((i) => i.status === "done" || i.status === "dropped").length,
                  total: e.plan.items.length
                });
              } else if (e.kind === "note") {
                setAgentLive((s) => (s ? { ...s, notes: [...s.notes, e.text] } : s));
              } else if (e.kind === "answering") {
                answerStarted();
                voice?.onStatus({ kind: "answering" });
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
            maxTokens: threadMax,
            signal: controller.signal,
            label: "chat",
            /* Image mode is the Image action plus two dials, and the action
               rides along rather than being written onto the conversation —
               see lib/chatActions.ts. */
            actions: actionsFor(c.mode, c.actions),
            image: c.mode === "image" ? c.image || DEFAULT_IMAGE_SPEC : undefined,
            pdfEngine,
            onToken: (_t, a) => {
              answerStarted();
              acc = a;
              setStreaming(a);
            },
            onReasoning: (_chunk, all) => {
              reasoned = true;
              chain = all;
              setThinking((t) => (t ? { ...t, text: all } : t));
            },
            /* The evidence in the opaque case. A model can reason without
               sending a word of it, and `reasoned` here is the difference
               between "thought for nine seconds, working not shown" and a
               reply that was simply slow to start. */
            onFinish: (info) => {
              if (info.reasoned) reasoned = true;
            },
            onCitations: (cs) => {
              citations = cs;
            },
            onImages: (urls) => {
              drawn = urls;
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
              if (u.reasoningTokens) reasoned = true;
              usage = { ...u, cost: u.reportedCost ?? costOf(u, priceForModel(AI.resolve({ backend: runBackend, model: runModel }).type, runModel)) };
            }
          },
          { backend: runBackend, model: runModel }
        );

        const raw = full || acc;
        /* A picture is a reply. An image model asked for one often returns it
           with no sentence around it at all, and this guard would have thrown
           away the most expensive thing in the app. */
        if (!raw.trim() && !drawn.length && !videos.length) throw new Error("The model returned an empty reply.");

        /* Out of the reply and into the file store before the variant is
           written, so the variant never holds base64 and never points at bytes
           that were not kept. */
        /* Titled by what was asked for — the last thing the learner typed
           before this reply, which is the sentence the picture is of. */
        const asked = [...c.turns.slice(0, upToIndex + 1)].reverse().find((t) => t.role === "user");
        const images = drawn.length
          ? await keepGenerated(
              drawn,
              asked ? chatStore.activeContent(asked) : c.title,
              /* What was asked for at the moment it was drawn. The dial moves;
                 this picture's receipt must not move with it. */
              c.mode === "image" ? (c.image || DEFAULT_IMAGE_SPEC).aspect : undefined
            )
          : undefined;

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

        /* Both halves of the record, and both are conditional on evidence.
           The chain is capped because a conversation is rewritten whole on
           every message; the duration is written only when something actually
           said the model reasoned, or it would be latency wearing the word
           "thought". */
        const kept = reasoned ? capReasoning(chain) : { text: "", clipped: false };
        targetTurn.variants.push({
          content,
          model: runModel,
          usage,
          elapsed: Date.now() - started,
          reasoning: kept.text || undefined,
          reasoningMs: reasoned ? (thoughtUntil ?? Date.now()) - started : undefined,
          createdAt: Date.now(),
          saved,
          citations,
          trace,
          agentProposed,
          images: images?.length ? images : undefined,
          videos: videos.length ? videos : undefined
        });
        targetTurn.active = targetTurn.variants.length - 1;
        targetTurn.error = undefined;
        chatStore.addUsageTo(c, usage);
        applyCut(c, targetTurn);
        chatStore.persist(c, true);

        void maybeTitle(c);
        /* The one extra request per message, and the reason a single send
           used to look like two. Gated twice on purpose: turned off wholesale
           in Settings, and skipped at low effort regardless. Never in voice:
           nobody taps a suggestion chip mid-conversation. */
        /* Nor after a picture or a clip: a follow-up question is a thing to
           say to a model that talks, and the next prompt here is a picture. */
        if (!voice && c.mode !== "image" && c.mode !== "video" && budget.followups && store.settings().followups) void maybeFollowups(c);
      } catch (e) {
        if (isAbort(e)) {
          // Keep whatever streamed in before the stop — half an explanation is
          // still worth reading, and discarding it would be hostile.
          if (acc.trim()) {
            targetTurn.variants.push({
              content: acc,
              model: runModel,
              elapsed: Date.now() - started,
              /* Kept on the stopped path for the reason the half-answer is:
                 you pressed stop *because* of what you were reading, and the
                 working is half of what you were reading. */
              reasoning: reasoned ? capReasoning(chain).text || undefined : undefined,
              reasoningMs: reasoned ? (thoughtUntil ?? Date.now()) - started : undefined,
              createdAt: Date.now(),
              /* Whatever the loop got through before the stop is still the
                 honest account of how that half-answer was reached. */
              trace
            });
            targetTurn.active = targetTurn.variants.length - 1;
            applyCut(c, targetTurn);
            chatStore.persist(c, true);
          } else if (targetTurn.videoJob) {
            /* Stopping the wait does not stop the clip — OpenRouter has no way
               to cancel one — so the turn stays, with the job, and says so.
               Retry waits for the same clip; it is not paid for twice. */
            targetTurn.error = "Stopped waiting. OpenRouter may still finish this clip and bill it — Retry picks the wait back up.";
            chatStore.persist(c, true);
          } else {
            chatStore.removeTurn(c, targetTurn.id);
          }
          outcome = { ok: false };
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
            applyCut(c, targetTurn);
          }
          /* A clip that failed is over: the next Retry asks for a new one. A
             clip that was still going when the connection went is not: the
             job stays, and Retry goes back to waiting for it. */
          if (targetTurn.videoJob && e instanceof ClipFailed) {
            AI.meterVideo(targetTurn.videoJob.model, undefined, undefined, true);
            targetTurn.videoJob = undefined;
          }
          targetTurn.error = targetTurn.videoJob ? msg + " Retry keeps waiting for the same clip." : msg;
          setError(msg);
          chatStore.persist(c, true);
          outcome = { ok: false, error: msg };
        }
      } finally {
        abortRef.current = null;
        busyRef.current = false;
        pendingCuts.current.delete(targetTurn.id);
        voice?.onDone(outcome);
        setBusy(false);
        setStreaming(null);
        setStreamingTurnId(null);
        setThinking(null);
        setAgentLive(null);
        rerender();
      }
    },
    [buildMessages, rerender, applyCut]
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
          /* A thread pinned to a model that only draws or films cannot be
             asked for a title — the request fails, and fails again on every
             such thread. Those are titled by the default chat model. */
          const kinds = catalogueEntry(AI.resolve({ backend: c.backend, model: c.model }).model)?.kinds;
          const writes = !kinds?.length || kinds.includes("chat");
          title = await AI.generateTitle(chatStore.activeContent(firstUser), chatStore.activeContent(firstAsst), {
            backend: c.backend,
            model: writes ? c.model : undefined
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
    async (text: string, attachments?: Attachment[], voice?: VoiceTurn) => {
      /* The composer disables its button while a reply streams, but send() is
         also reached from starters, slash commands, follow-up chips and the
         command palette — and a second run() would overwrite abortRef with
         its own controller, leaving the first request live with nothing able
         to stop it, both of them writing variants and both fighting over the
         streaming buffer. The guard belongs here, next to the state it
         protects, not in each of the six callers. Read from refs, because
         voice mode calls this from a closure several renders old. */
      if (busyRef.current) return;

      let c = convRef.current;
      if (!c) {
        // A model picked on the empty screen has to survive the conversation
        // being created here, or choosing one before typing does nothing.
        c = chatStore.create(withDrafts());
        convRef.current = c;
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
      const said = chatStore.makeTurn("user", body, attachments);
      const assistant = blankAssistantTurn();
      if (voice) said.voice = assistant.voice = true;
      chatStore.addTurn(c, said);
      c.turns.push(assistant);
      chatStore.persist(c);
      rerender();

      await run(c, assistant, c.turns.length - 2, undefined, voice);
    },
    [openChat, run, rerender, withDrafts]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const cutReply = useCallback(
    (turnId: string, text: string) => {
      pendingCuts.current.set(turnId, text);
      const c = convRef.current;
      const turn = c?.turns.find((t) => t.id === turnId);
      /* Still arriving: run() applies it the moment the text lands. */
      if (!c || !turn || !turn.variants.length || (busyRef.current && abortRef.current)) return;
      applyCut(c, turn);
      rerender();
    },
    [applyCut, rerender]
  );

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

  /* A clip still being made when this thread was last open — the tab was
     closed, the app reloaded, you went to another thread. The job is on the
     turn and running on OpenRouter regardless, so opening the thread goes
     back to waiting for it rather than leaving a reply that will never land.
     busyRef, not state: StrictMode runs this twice, and run() sets the ref
     synchronously, so the second pass sees the first and stands down. */
  useEffect(() => {
    const c = conversation;
    if (!c || busyRef.current) return;
    const idx = c.turns.findIndex((t) => t.role === "assistant" && t.videoJob && !t.variants.length && !t.error);
    if (idx < 1) return;
    void run(c, c.turns[idx], idx - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id]);

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
    thinking,
    agentLive,
    busy,
    error,
    followups,
    send,
    stop,
    cutReply,
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
    draftImage,
    setDraftImage,
    draftVideo,
    setDraftVideo,
    setDraftActions
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChat(): ChatState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

/** Settings is one surface opened from every section, and one of its
 *  categories — "This chat" — is only meaningful inside chat. This is how it
 *  asks whether it is there, rather than being offered in every view and
 *  throwing in five of them. */
export function useMaybeChat(): ChatState | null {
  return useContext(Ctx);
}
