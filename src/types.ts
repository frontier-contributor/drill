/* ============================================================================
 * Shared types for Drill's data model. Mirrors the shapes documented in the
 * original db.js / fsrs.js / ai.js / config.js comments.
 *
 * Projects, memory and the upgraded note live in types/core.ts; the ones this
 * file needs are re-exported below so `@/types` stays the single import for
 * the review side of the app.
 * ========================================================================== */
import type { Autonomy, Effort, Note, Project } from "@/types/core";
import type { ChatActionId } from "@/lib/chatActions";
import type { VisualKind } from "@/lib/visuals/catalogue";

export type { Autonomy, Effort, Note, Project } from "@/types/core";
export type {
  BackupSummary,
  FullBackup,
  KnowledgeItem,
  Memory,
  MemoryCandidate,
  MemoryOrigin,
  MemoryPolicy,
  MemoryScope,
  MemorySource,
  MemoryType,
  NoteSource,
  ProjectDefaults
} from "@/types/core";

export type Grade = 1 | 2 | 3 | 4;

export type CardState = "new" | "learning" | "review" | "relearning";

export interface Card {
  id: string;
  tag: string;
  q: string;
  a: string;
  /** Where this card came from, so a failing card can be traced back to the
   *  day it was learned. Absent for cards written before Phase 2. */
  sourceRef?: { kind: "journal" | "exam" | "chat" | "note" | "manual"; id: string };
  /** When the card was written, so "what did I make today" is answerable and
   *  the library can be ordered by age. Stamped by store.normCard; absent on
   *  cards that predate it, which sort as oldest. */
  created?: number;
}

/** FSRS-6 scheduling state for one card. */
export interface SRSState {
  id: string;
  state: CardState;
  step: number;
  /** memory stability, in days */
  S: number;
  /** difficulty, 1..10 */
  D: number;
  /** next due timestamp, ms epoch */
  due: number;
  reps: number;
  lapses: number;
  /** last review timestamp, ms epoch */
  last: number;
  /** last computed retrievability, 0..1 */
  lastR?: number;
}

export interface DeckMeta {
  newToday: number;
  dayKey: string;
  streak: number;
  lastActive: string | null;
  reviews: number;
}

export interface Deck {
  id: string;
  name: string;
  created: number;
  /** Which project this deck belongs to. Every deck has one from v4 onward;
   *  the migration files pre-existing decks under the default project. */
  projectId: string;
  cards: Card[];
  srs: Record<string, SRSState>;
  meta: DeckMeta;
}

export type Lang = "english" | "hinglish";

/** A curated hue, not a raw color picker — every option is tuned to the same
 *  lightness/chroma family so nothing reads as an accident against the rest
 *  of the dark palette. See lib/theme.ts for the oklch values. */
export type Accent = "blue" | "violet" | "teal" | "green" | "amber" | "rose";

/** Trims padding and line-height on list-heavy surfaces (decks, chat
 *  sidebar, the insight log) without touching the reading surfaces —
 *  density is about chrome, textScale below is about reading. */
export type Density = "comfortable" | "compact";

/** Which printing of the book to render: `night` (warm dark, the default —
 *  Drill is used in the evening) or `day` (warm paper). Both are the same
 *  design; only the ink and the paper swap. See lib/theme.ts. */
export type Theme = "night" | "day";

/** One backend's saved credentials. */
export interface BackendCreds {
  key: string;
  model: string;
  baseUrl: string;
}

export interface Settings {
  backend: string;
  /** The live credentials — whichever backend is currently selected. */
  key: string;
  model: string;
  baseUrl: string;
  /** The same three fields, remembered per backend, so switching provider and
   *  switching back does not lose the key you already pasted. Keyed by a
   *  plain string rather than BackendType on purpose: a backend removed from
   *  the union leaves its entry sitting here harmlessly instead of taking a
   *  secret down with it. store.setBackend is the only thing that writes it. */
  creds: Record<string, BackendCreds>;
  newPerDay: number;
  tutor: string;
  lang: Lang;
  retention: number;
  maxIvl: number;
  recall: boolean;
  mark: boolean;
  mix: boolean;
  interleave: boolean;
  /** Default context depth / model tier for a message. Projects and single
   *  conversations may override it. */
  effort: Effort;
  /** How freely memory may be written without being asked. */
  autonomy: Autonomy;
  /** Whether to spend a second request per message on three suggested
   *  follow-up questions. Off by default: one message should be one request
   *  unless you have said otherwise. Also forced off at low effort. */
  followups: boolean;
  /** Whether to spend one request naming a new conversation from its opening
   *  exchange. On by default, because it is one request per *thread* and a
   *  sidebar of "New chat" is unusable. Off falls back to a title written
   *  from the first message locally — see lib/title. Either way it is
   *  attempted at most once per conversation. */
  autoTitle: boolean;
  /** Appearance — applied at runtime via lib/theme.ts, not baked into the
   *  stylesheet, so a new option here never needs a CSS release. */
  theme: Theme;
  accent: Accent;
  density: Density;
  /** Sidebar collapsed to its icon rail. Desktop only — under 900px the
   *  sidebar is a drawer and this is ignored, so a phone never overwrites
   *  what you chose at a desk. */
  navCollapsed: boolean;
  /** The right-hand instrument panel, folded to its edge. Same idea as
   *  navCollapsed and remembered the same way — under 1180px the rail is
   *  gone from the layout entirely and this is ignored. */
  railCollapsed: boolean;
  /** Multiplier on card/chat reading text only (not UI chrome). 0.9-1.2. */
  textScale: number;
  /** How many cards a session asks for when you start one. A session is a
   *  bounded amount of work for today, not a cap on the queue — the queue
   *  keeps serving after it, you just get told you are done. */
  sessionSize: number;
  /** Reading replies aloud: which voice, how fast, what is kept. Nested, so
   *  store.normSettings fills its fields — the load-time merge is shallow and
   *  would otherwise hand an older database a half-empty object. */
  speech: SpeechSettings;
  /** Where an attached PDF is read. See PdfEngine. */
  pdfEngine: PdfEngine;
  /** Kinds of figure switched off — see lib/visuals/catalogue.ts. A kind that
   *  is off is never taught to the model and never drawn: its block shows as
   *  code, which is what it is. */
  visualsOff: VisualKind[];
}

/* --------------------------------------------------------------- speech -- */

/** Who reads a reply aloud: this device's own voice, or a backend's. Ollama
 *  has no speech endpoint, so it is not one of them. */
export type SpeechEngineId = "device" | "openrouter" | "groq" | "custom";

/** The model and voice one engine uses. The device engine keeps a voiceURI
 *  in `voice` and leaves `model` empty. */
export interface SpeechChoice {
  model: string;
  voice: string;
}

export interface SpeechSettings {
  /** "" is automatic: OpenRouter's voice when a key for it is saved,
   *  otherwise this device's. */
  engine: SpeechEngineId | "";
  /** Playback speed, 0.75–2. */
  rate: number;
  /** Highlight the sentence being read and keep it on screen. */
  follow: boolean;
  /** Megabytes of already-heard audio kept for free replays. 0 keeps none. */
  cacheMB: 0 | 25 | 100;
  /** Each engine remembers its own model and voice, the way `creds`
   *  remembers each backend's key, so switching and switching back loses
   *  nothing. */
  voices: Partial<Record<SpeechEngineId, SpeechChoice>>;
}

/**
 * A day's bounded run of cards, started on demand.
 *
 * The review queue is endless by design: it serves whatever is due, forever.
 * That is correct for scheduling and hopeless as a thing to sit down to, so a
 * session puts a finish line somewhere — you ask for ten cards, you can see
 * how far through you are, and arriving is a real moment rather than the
 * queue quietly running dry.
 *
 * Scoped to a day and a project. Asking again on the same day resumes rather
 * than restarting, so a reload mid-session does not lose your place.
 */
export interface Session {
  /** U.today() when it was started. A session from yesterday is not resumed. */
  day: string;
  projectId: string;
  /** How many cards were asked for. */
  target: number;
  /** How many have been graded since it started. */
  done: number;
  startedAt: number;
}

/**
 * One graded card, as it happened.
 *
 * The first four fields are all this ever held, which made the log good for
 * counting and useless for remembering: you could tell that thirty cards were
 * reviewed on Tuesday but not *which* ones, so nothing downstream could
 * answer "what did I get wrong today". The last three close that — they are
 * optional because every entry written before they existed lacks them, and a
 * missing card id must degrade to "unknown card", never to a crash.
 *
 * Kept deliberately terse. The log is capped at 8000 entries and lives in
 * localStorage alongside everything else, so `a` is truncated on the way in.
 */
export interface LogEntry {
  t: number;
  g: Grade;
  s: CardState;
  d: string;
  /** Card id. Added 2026-09; absent on older entries. */
  c?: string;
  /** What the learner actually wrote when recalling it, truncated. Only
   *  present when recall mode was on and they typed something. */
  a?: string;
  /** The marker's verdict on that attempt, when one was marked. */
  v?: MarkResult["verdict"];
  /**
   * What the marker said was missing — the precise diagnosis, in its words.
   *
   * Added 2026-09-10, and the reason is worth stating: this is the single
   * most useful sentence the app ever produces about a learner, generated by
   * a model that had the card, the correct answer and what they actually
   * wrote in front of it — and it used to be rendered under the card for a
   * few seconds and thrown away. Every later call rediscovered the same
   * confusion from scratch. lib/gaps clusters these into what the learner is
   * currently getting wrong, and lib/memoryBrief puts that in front of every
   * AI call in the app.
   */
  m?: string[];
}

export interface DrillDB {
  v: 4;
  /** Active deck id. */
  active: string;
  /** Active project id. Always points at a project that exists. */
  activeProjectId: string;
  projects: Record<string, Project>;
  settings: Settings;
  log: LogEntry[];
  notes: Note[];
  decks: Record<string, Deck>;
  /** Today's bounded run, or null when none has been started. */
  session: Session | null;
}

/** { deck, def: card, st: srs state } — the unit the review loop works with. */
export interface QueueItem {
  deck: Deck;
  def: Card;
  st: SRSState;
}

/* ---------------------------------------------------------------- config -- */

export type BackendType = "openrouter" | "groq" | "ollama" | "custom";

/** How a backend's calls get costed.
 *
 *   catalogue  look the model up in OpenRouter's published prices
 *   free       genuinely nothing to pay — local inference, or a free tier
 *   unpriced   we do not know, and say so rather than guessing
 *
 * The third state is the point. A missing price used to be indistinguishable
 * from a zero one, so a custom endpoint pointed at a paid API reported every
 * call as free. */
export type PricingMode = "catalogue" | "free" | "unpriced";

export interface InferenceConfig {
  type: BackendType;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  headers: Record<string, string>;
}

export interface DecksConfig {
  defaultPath: string;
  autoSync: boolean;
}

export interface UIConfig {
  retentionTarget: number;
  newPerDay: number;
  language: string;
}

export interface FSRSConfig {
  weights: number[] | null;
  maxInterval: number;
  learningSteps: number[];
  relearningSteps: number[];
  fuzz: boolean;
  leechThreshold: number;
}

export interface DrillConfig {
  inference: InferenceConfig;
  decks: DecksConfig;
  ui: UIConfig;
  fsrs: FSRSConfig;
}

/* ------------------------------------------------------------------ fsrs -- */

export interface FSRSParams {
  weights: number[];
  retention: number;
  maxInterval: number;
  learningSteps: number[];
  relearningSteps: number[];
  fuzz: boolean;
  leechThreshold: number;
  rng?: () => number;
}

/* -------------------------------------------------------------------- ai -- */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One tool the model asked to run, as it travels on the wire. `args` is
 *  already parsed — backends hand over JSON strings and the adapter is where
 *  that stops being everyone else's problem. */
export interface WireToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One piece of a message that is not only words. The text is also kept in
 *  `content`, so every text-only reader — the run transcript, the token
 *  estimate, a backend that cannot see — still has it. `data` is base64 with no
 *  data-URL prefix; each adapter spells the envelope its own way. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string; name: string }
  | { type: "file"; mime: string; data: string; name: string };

/** Where a PDF is read. `local` is this browser, with pdf.js, and works on every
 *  backend; the other three are OpenRouter's file parser, and only it has them. */
export type PdfEngine = "local" | "cloudflare-ai" | "mistral-ocr" | "native";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Pictures and files sent with this message. Absent on text-only messages,
   *  which is every message except a user turn with something attached. */
  parts?: ContentPart[];
  /** Assistant messages that requested tools. Additive: every existing caller
   *  builds `{role, content}` and still typechecks. */
  toolCalls?: WireToolCall[];
  /** Set on a `tool` message, naming the call it answers. */
  toolCallId?: string;
  /** The tool's name, which some providers require on the result message. */
  name?: string;
}

/** Token counts for one exchange. `cost` is only set when the backend
 *  publishes pricing — undefined means unknown, never free. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Of promptTokens, how many were served from the provider's prompt cache.
   *  Reported for display only — cache pricing is a per-vendor multiplier the
   *  catalogue does not expose, so costing it would be guesswork. */
  cachedPromptTokens?: number;
  /** Of completionTokens, how many went on reasoning rather than the answer. */
  reasoningTokens?: number;
  /** What the provider says it actually charged, when it says so. Preferred
   *  over anything reconstructed from a price table: it is the real number,
   *  and it includes non-token fees like web search that a tokens-times-price
   *  calculation cannot see. */
  reportedCost?: number;
  cost?: number;
}

export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  onToken?: (token: string, acc: string) => void;
  /** Reported once at the end of a call, when the backend returns counts. */
  onUsage?: (u: TokenUsage) => void;
  /** Aborts the request. A cancelled call rejects with an AbortError, which
   *  callers are expected to swallow rather than surface as a failure. */
  signal?: AbortSignal;
  /** What kind of operation this is — "journal", "distill", "exam", "chat"…
   *  Recorded on the run transcript so "what is it doing" has an answer. */
  label?: string;
  /** Extra capabilities to switch on for this call (web search, and whatever
   *  follows it). Silently ignored by a backend that does not support one —
   *  the composer is what stops you asking in the first place. */
  actions?: ChatActionId[];
  /** Sources the backend cited, reported once when the reply is complete. */
  onCitations?: (c: Citation[]) => void;
  /**
   * Pictures the reply came back with, as `data:` URLs, reported once before
   * the promise settles.
   *
   * A side channel rather than a return value, like every other non-text thing
   * a reply can produce here — `chat()` resolves to a string and fifteen
   * callers depend on that. The bytes are handed over raw: what to do with
   * them is the caller's, because only the caller knows whether they are worth
   * keeping (a chat reply) or should be dropped on the floor (a one-shot
   * operation that asked for JSON).
   */
  onImages?: (dataUrls: string[]) => void;
  /** Tool definitions, already compiled to the provider's shape by
   *  services/agent/protocol.ts. Only the OpenAI-compatible adapter reads
   *  this; a backend that ignores it degrades to a plain reply, which the
   *  agent loop correctly treats as "no calls, this is the answer". */
  tools?: unknown[];
  /** Tools the model asked for. Called once per reply, before the promise
   *  settles, so a reply that is *only* tool calls still reports them. */
  onToolCalls?: (calls: WireToolCall[]) => void;
  /** Reasoning, turned down for a one-shot operation that ran out of room —
   *  lib/budget.ts decides when. Sent by the OpenRouter adapter only, and never
   *  alongside the Think action, which owns reasoning for chat replies. */
  reasoning?: { effort: ReasoningEffort };
  /** Ollama's own thinking switch, for the same purpose and on the same
   *  evidence. */
  think?: boolean;
  /** How the reply ended, reported once before the promise settles: whether
   *  the token cap stopped it, and whether the model reasoned first. What lets
   *  services/ai/structured.ts tell "ran out of room" from "said something
   *  unparseable". */
  onFinish?: (info: FinishInfo) => void;
  /** Which of OpenRouter's parsers reads a PDF sent as a file. Always named
   *  when a file goes out: left unset, OpenRouter's documented default is its
   *  paid OCR engine. Ignored by every other backend, which is never sent one. */
  pdfEngine?: Exclude<PdfEngine, "local">;
}

/** The reasoning levels this app sends. OpenRouter accepts more; these are the
 *  ones every reasoning family behind it understands. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface FinishInfo {
  /** The provider's finish_reason (Ollama's done_reason), verbatim. */
  reason?: string;
  /** The model produced reasoning before, or instead of, its answer. */
  reasoned: boolean;
  /** Stopped by the token cap rather than by finishing. */
  partial: boolean;
}

/** One source a web-search-backed reply drew on. `start`/`end` are character
 *  offsets into the reply text, when the backend reports them. */
export interface Citation {
  url: string;
  title: string;
  /** The excerpt the search engine extracted. May be long. */
  content?: string;
  start?: number;
  end?: number;
}

/** Resolved backend + credentials for one call. */
export interface AIContext {
  apiKey: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
}

/** One piece of text to turn into audio. */
export interface SpeechRequest {
  model: string;
  voice: string;
  input: string;
  signal?: AbortSignal;
}

/** The audio for one request, whole. Compressed bytes, never decoded: a
 *  minute of mp3 is about half a megabyte and the same minute as raw samples
 *  is ten times that. */
export interface SpeechClip {
  audio: ArrayBuffer;
  mime: string;
  /** OpenRouter's id for the request, kept on the run transcript. */
  generationId?: string;
}

/** What a backend needs to read aloud. Absent means it cannot. */
export interface SpeechDef {
  /** Where its speech models and their voices are listed:
   *    catalogue  OpenRouter's /models?output_modalities=speech
   *    fixed      written here, because the provider publishes no list
   *    typed      whatever you type — a server nothing can ask in advance */
  source: "catalogue" | "fixed" | "typed";
  defaultModel: string;
  defaultVoice: string;
  /** Characters one request may carry. Groq refuses more than 200. */
  maxChars: number;
  /** For `fixed`: each documented model and its voices. */
  models?: Record<string, string[]>;
  synthesize(req: SpeechRequest, ctx: AIContext): Promise<SpeechClip>;
}

export interface BackendDef {
  id: BackendType;
  label: string;
  needsKey: boolean;
  /** Absent means "unpriced" — a new backend has to opt in to claiming a
   *  price, rather than inheriting someone else's assumption. */
  pricing?: PricingMode;
  local: boolean;
  keyUrl: string;
  defaultBaseUrl: string;
  defaultModel: string;
  note: string;
  /** Which chat actions this backend can actually perform. Absent means none
   *  — see lib/chatActions.ts. */
  supports?: ChatActionId[];
  /** Reading replies aloud, when the provider has a speech endpoint. */
  speech?: SpeechDef;
  chat(messages: ChatMessage[], opts: ChatOpts, ctx: AIContext): Promise<string>;
  listModels(ctx: AIContext): Promise<string[]>;
}

export interface ResolvedBackend {
  type: BackendType;
  backend: BackendDef;
  apiKey: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  temperature?: number;
  keyFromConfig: boolean;
  modelFromConfig: boolean;
  backendFromConfig: boolean;
}

export interface MarkResult {
  grade: Grade;
  verdict: "got" | "partial" | "missed";
  missing: string[];
  note: string;
}

/* -------------------------------------------------------------- payloads -- */

export interface DeckPayload {
  kind: "cards";
  name: string | null;
  cards: unknown[];
}

export interface BackupPayload {
  kind: "backup";
  data: DrillDB | LegacyDBv3 | LegacyDBv2;
}

export type ImportPayload = DeckPayload | BackupPayload;

export interface ValidateResult {
  ok: Card[];
  problems: string[];
}

export interface ExampleDeckEntry {
  file: string;
  name: string;
  cards: number;
  description: string;
}

/* ---------------------------------------------------------- legacy (v3) -- */
/* v3 had no projects: decks were a flat map and notes were {id,t,text,tag}.
   Kept so a v3 backup exported before the upgrade still restores. */

export interface LegacyNoteV3 {
  id: string;
  t: number;
  text: string;
  tag: string;
}

export interface LegacyDeckV3 {
  id: string;
  name: string;
  created: number;
  cards: Card[];
  srs: Record<string, SRSState>;
  meta: DeckMeta;
  /** absent in true v3 records; present once migrated */
  projectId?: string;
}

export interface LegacyDBv3 {
  v: 3;
  active: string;
  settings: Partial<Settings>;
  log: LogEntry[];
  notes: LegacyNoteV3[];
  decks: Record<string, LegacyDeckV3>;
}

/* ---------------------------------------------------------- legacy (v2) -- */

export interface LegacyDBv2 {
  active: string;
  settings?: Partial<Settings> & Record<string, unknown>;
  decks: Record<string, LegacyDeckV2>;
}

export interface LegacyDeckV2 {
  id: string;
  name: string;
  created: number;
  cards: Partial<Card>[];
  srs?: Record<string, LegacySRSv2>;
  meta?: DeckMeta;
}

export interface LegacySRSv2 {
  ivl?: number;
  ease?: number;
  stage?: string;
  due?: number;
  reps?: number;
  lapses?: number;
}
