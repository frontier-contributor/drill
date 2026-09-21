/* ============================================================================
 * chat.ts — the chat platform's data model.
 *
 * A conversation is a flat list of turns. Assistant turns carry *variants*
 * (one per regeneration) rather than the app keeping a message tree: the
 * cases people actually use are "give me that again" and "take this
 * somewhere else", and the second is served by branching into a new
 * conversation instead of an invisible tree node.
 * ========================================================================== */
import type { BackendType, Citation, TokenUsage } from "@/types";
import type { ChatActionId } from "@/lib/chatActions";
import type { AgentTrace } from "@/types/agent";
import type { Effort, MemoryScope } from "@/types/core";

/**
 * How a message is answered. Three genuinely different purchases, not a
 * quality slider — each is the right answer to a different kind of question.
 *
 *   direct  one request. Context is chosen deterministically by
 *           lib/chatContext.ts before the call. Fast, cheap, and correct for
 *           "explain this to me", which is most messages.
 *
 *   agent   the model looks things up itself, reactively, then answers. For
 *           "what am I still getting wrong" — where what to fetch second
 *           depends on what the first lookup returned.
 *
 *   deep    the model states a plan, works it, closes every step, and only
 *           then answers. For questions worth several minutes: "where am I
 *           actually weak across this whole project", "what should I do next".
 *           Slower and dearer than `agent` on purpose — the plan is what makes
 *           a long run auditable and stops it declaring victory early.
 *
 * Per conversation rather than global: the mode that suits a thread is a
 * property of what the thread is for, and a global switch would make every
 * quick question expensive.
 */
export type ChatMode = "direct" | "agent" | "deep";

/** Re-exported so chat code has one import for its own vocabulary. */
export type Usage = TokenUsage;

export type TurnRole = "user" | "assistant";

/** What an attachment is. The first five are text the app already had or that
 *  was pasted; the last four came from a file and were read in this browser. */
export type AttachmentKind = "file" | "selection" | "card" | "note" | "deck" | "image" | "pdf" | "doc" | "sheet";

/** A file or snippet pulled into a turn. The text is inlined into the wire
 *  message when sending; this record exists so the UI can show a card and so
 *  an edited turn can be rebuilt without re-reading the file. */
export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** bytes for files, characters otherwise — for the card's subtitle */
  size: number;
  /** What the model reads. The extracted text for a PDF, a Word file or a
   *  spreadsheet; empty for an image, which is sent as itself. */
  text: string;
  /** The original bytes, kept in the `drill-files` database — never inline
   *  here, because a conversation record is rewritten whole on every message
   *  and a photograph inside it would be rewritten with it. */
  fileId?: string;
  mime?: string;
  /** Pages in a PDF, sheets in a workbook. */
  pages?: number;
  /** PDF pages with no text layer — scans — numbered from 1. */
  scanned?: number[];
  /** Those scanned pages rendered as pictures, for a model that can see. */
  pageImages?: string[];
  /** A small JPEG data URL drawn in this browser, for the card. */
  thumb?: string;
  /** An image's size as it will be sent, after downscaling. */
  dims?: { w: number; h: number };
  /** The extracted text was cut at the limit. */
  truncated?: boolean;
  /** Ride on every message in this conversation, not only the one it came with. */
  pinned?: boolean;
}

/** What a save-to-memory request did, recorded on the turn that caused it so
 *  the result is still there after a reload. Compact on purpose: the live
 *  state of a queued item is read back from the candidate tray, not frozen
 *  here, so accepting one elsewhere does not leave this block lying. */
export interface SavedMemory {
  committed: { id: string; text: string; type: string }[];
  queued: { id: string; text: string; type: string; supersedes: string | null }[];
  /** Dropped as duplicates — shown so "nothing saved" never looks like a bug. */
  skipped: { text: string; existingText: string }[];
  atCap: boolean;
}

/**
 * A picture the model drew, on the reply that drew it.
 *
 * The bytes are in the `drill-files` database under `fileId`, never here, for
 * the reason spelled out on `Attachment` above: a conversation is one record
 * and it is rewritten whole on every message, so a picture stored inside it
 * would be re-serialised on every message after it for the life of the thread.
 *
 * `thumb` is the exception and is here on purpose — a hundred-odd characters
 * of JPEG so a list can draw the picture without opening the file store.
 */
export interface GeneratedImage {
  id: string;
  fileId: string;
  mime: string;
  w: number;
  h: number;
  /** A small JPEG data URL, drawn in this browser. */
  thumb?: string;
  /** Bytes, for the receipt under the reply. */
  size: number;
  /** What was asked for — the user's own message — so a kept picture has a
   *  title without anyone having to name it. */
  prompt?: string;
  createdAt: number;
}

/** One generation of an assistant turn, or one edit of a user turn. */
export interface Variant {
  content: string;
  model?: string;
  usage?: Usage;
  /** ms spent streaming, for the "12.4s · 830 tok" footer */
  elapsed?: number;
  /**
   * The model's working, when the provider sent it as text. Capped by
   * lib/reasoning.ts, which keeps both ends and elides the middle.
   *
   * Persisted, unlike the agent loop's live state, for the reason the trace is
   * persisted: a reply you cannot audit is a reply you cannot correct. The
   * cost is real — a conversation is rewritten whole on every message — which
   * is what the cap is for.
   */
  reasoning?: string;
  /** ms from the request starting to the first answer token: how long it
   *  thought. Set even when `reasoning` is absent, because "it thought for
   *  nine seconds and will not show you the working" is the honest reading of
   *  a model that hides its chain, and the panel says exactly that. */
  reasoningMs?: number;
  createdAt: number;
  /** Present when this reply saved something to memory. */
  saved?: SavedMemory;
  /** Sources a web-search reply drew on. */
  citations?: Citation[];
  /** How an agent-mode reply was arrived at — every lookup it made and what
   *  came back. Persisted rather than kept in memory because an answer you
   *  cannot audit is an answer you cannot correct, and the whole argument for
   *  letting a model go and look things up is that you can check its working. */
  trace?: AgentTrace;
  /** What an agent-mode reply proposed along the way, so the turn can show one
   *  receipt instead of burying it in the trace. */
  agentProposed?: { id: string; text: string; kind: "memory" | "card" | "note" }[];
  /** What hearing this reply read aloud has cost, across every time it was
   *  played. Replays from saved audio add nothing, because nothing was spent.
   *  `cost` undefined means the voice has no published price, not free. */
  listened?: { chars: number; cost?: number };
  /** Pictures this generation drew. Per variant rather than per turn, so
   *  regenerating gives a new picture and the variant arrows step between
   *  them rather than piling them up under one reply. */
  images?: GeneratedImage[];
}

export interface Turn {
  id: string;
  role: TurnRole;
  variants: Variant[];
  /** index into variants */
  active: number;
  attachments?: Attachment[];
  /** set when the request failed; the turn stays so it can be retried */
  error?: string;
  /** user marked this worth keeping */
  starred?: boolean;
  createdAt: number;
}

/** What the app injects ahead of the user's own messages. Recomputed at send
 *  time, never frozen into the transcript, so it tracks your actual progress. */
export type ContextSource =
  | { kind: "deck"; deckId: string }
  | { kind: "weak"; deckId: string | null }
  | { kind: "notes"; limit: number }
  | { kind: "due"; deckId: string | null }
  /** Retrieved memory. Live like the rest: scored fresh at send time, so a
   *  conversation reopened next month reflects what is known by then. */
  | { kind: "memory"; scope: MemoryScope | "both"; limit: number }
  /** The project's always-attached files and text. */
  | { kind: "knowledge" }
  /** The last `days` days of journal entries for this project. */
  | { kind: "journal"; days: number }
  /**
   * Today, assembled from everywhere at once: what was reviewed and how it
   * went, the sentences the learner actually wrote when recalling, cards and
   * memories written, and anything captured in the journal — summarised or
   * not.
   *
   * Every other source is a *category* of thing. This one is a moment, and it
   * is the source that makes "what did I learn today?" answerable at all: the
   * journal source only sees entries that have been through the narrative
   * step, and nothing else in this list has ever seen the review log.
   */
  | { kind: "today"; days?: number }
  /**
   * The figures the learner has kept — the shelf, not the thread.
   *
   * A list, deliberately: title, kind and the note they wrote about why it
   * was worth keeping. The block itself is what the `@` picker attaches
   * (lib/references.ts), because a canvas is a few hundred lines and sending
   * every kept one on every message would cost more than the conversation.
   * This source is how "the diagram I kept" resolves to something; that one
   * is how the model gets to read it.
   */
  | { kind: "figures"; limit?: number };

export interface Conversation {
  id: string;
  /** Which project this belongs to. Set on create; older records are filed
   *  under the active project by chatStore.repair(). */
  projectId: string;
  title: string;
  /** false until the model has named it, so an in-flight title does not flash */
  titled: boolean;
  created: number;
  updated: number;
  pinned: boolean;
  archived: boolean;

  backend: BackendType | "";
  model: string;
  personaId: string;
  /** overrides the persona's prompt when non-empty */
  systemPrompt: string;
  temperature: number;
  maxTokens: number;

  /** "" means inherit from the project, which may inherit from global. */
  effort: Effort | "";
  /** Absent on conversations created before agent mode existed, which
   *  chatStore.repair() reads as "chat" — the cheap default, so an old thread
   *  never silently becomes expensive. */
  mode?: ChatMode;

  context: ContextSource[];
  /** Attachments that survive every turn, as opposed to Turn.attachments
   *  which are sent once. Pinning is the difference between paying for a file
   *  once and paying for it on every message. */
  pinnedAttachments: Attachment[];
  turns: Turn[];
  usage: Usage;

  /** Index of the last turn already folded into memory by a wrap-up, so
   *  running wrap-up again covers only what has been said since. */
  rolledUpThrough: number;
  /** Extra capabilities switched on for this thread — web search, and
   *  whatever follows it. Per conversation, not global: one thread wanting
   *  the live web should not turn it on for every other. */
  actions: ChatActionId[];
}

/** The sidebar reads these without loading full transcripts. */
export interface ConversationMeta {
  id: string;
  /** Lets the sidebar filter to the active project without loading transcripts. */
  projectId: string;
  title: string;
  titled: boolean;
  created: number;
  updated: number;
  pinned: boolean;
  archived: boolean;
  model: string;
  turnCount: number;
  /** first ~120 chars of the last turn, for the list subtitle */
  preview: string;
}

export interface Persona {
  id: string;
  name: string;
  blurb: string;
  prompt: string;
  /** built-ins cannot be deleted, only copied */
  builtin: boolean;
  /** suggested default; the conversation can still override */
  temperature?: number;
}

/** One model as the catalogue describes it: pricing per million tokens, plus
 *  the capabilities the same response happens to publish. Named for what it
 *  was first used for; see services/pricing.ts for why one fetch answers both
 *  questions. */
export interface ModelPrice {
  id: string;
  prompt: number;
  completion: number;
  contextLength?: number;
  name?: string;
  /** Whether the model accepts a reasoning parameter — the machine-readable
   *  answer to "can this one think?". Absent on a record written before the
   *  field existed, which reads as "not known", never as "no". */
  reasoning?: boolean;
  /** What the model accepts as input beyond text — "image", "file", "audio" —
   *  from the catalogue's `architecture.input_modalities`. Absent means not
   *  known, same convention as `reasoning`; ["text"] means text-only. Read by
   *  lib/modality.ts, which is what decides whether a picture is sent as
   *  itself and whether the attach menu offers one at all. */
  inputModalities?: string[];
  /** What it can produce, from `architecture.output_modalities`. A model that
   *  lists "image" can be asked for pictures; every other model in the
   *  catalogue lists "text" alone. Same absent-means-unknown convention. */
  outputModalities?: string[];
  /** USD per generated image, from the catalogue's `pricing.image`. Images are
   *  billed per picture rather than per token, so without this an image reply
   *  costs a row of zeros that looks exactly like a free one — the same hole
   *  `characters` fills for a voice. Absent means no published price. */
  imagePrice?: number;
  /** The most the model will write in one reply, from the catalogue's
   *  `top_provider.max_completion_tokens`. Absent means not known — which is
   *  also how a price cached before the field existed reads. lib/budget.ts
   *  clamps to it, because a max_tokens above it is refused by some providers. */
  maxOutput?: number;
}
