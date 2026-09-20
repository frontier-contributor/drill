/* ============================================================================
 * services/ai/index.ts — resolution, the chat entry point, and the three
 * features built on it: card writing, recall marking, and the tutor.
 *
 * Nothing in this file reads config directly; resolve() does that once, so
 * settings typed into the app always win over settings from a config file.
 *
 * This whole module is the "inference boundary" — if Drill grows a backend,
 * `chat()` is the one function to redirect (e.g. POST /api/chat with the same
 * ChatMessage[]/ChatOpts shape) instead of calling a BackendDef directly.
 * ========================================================================== */
import * as U from "@/lib/util";
import * as CFG from "@/lib/config";
import * as store from "@/services/store";
import * as transcript from "@/services/transcript";
import * as usageLog from "@/services/usageLog";
import { catalogueEntry, loadPricing, loadSpeechCatalogue, priceForModel, speechPriceFor } from "@/services/pricing";
import { costOf } from "@/lib/tokens";
import { memoryBrief, type BriefOpts } from "@/lib/memoryBrief";
import { cleanTitle } from "@/lib/title";
import { forTranscript } from "@/lib/files/parts";
import { planBudget } from "@/lib/budget";
import { thinkingSupport } from "@/lib/thinking";
import { BACKENDS, BACKEND_ORDER, isAbort } from "./backends";
import { makeStructured, type StructuredEnv } from "./structured";
import type {
  AIContext,
  BackendType,
  Card,
  ChatMessage,
  ChatOpts,
  InferenceConfig,
  MarkResult,
  ResolvedBackend,
  SpeechClip,
  SpeechEngineId,
  TokenUsage
} from "@/types";
import type { JournalEntry, JournalSummary, MemoryDiffLine } from "@/types/journal";
import type { Memory, MemoryScope, MemoryType, Project } from "@/types/core";
import type { Difficulty, ExamQuestion, QuestionKind } from "@/types/exam";

export { BACKENDS, BACKEND_ORDER };

/**
 * Work out which backend to call and with what. In-app Settings beat the
 * config file for every field, so a shared config.json can ship sane
 * defaults without pinning anyone to them.
 */
/** Per-call overrides. A chat conversation pins its own backend and model so
 *  changing the global default in Settings does not silently retarget a
 *  thread you are halfway through. */
export interface Override {
  backend?: BackendType | "";
  model?: string;
}

export function resolve(override?: Override): ResolvedBackend {
  const s = store.settings();
  const c = CFG.get().inference || ({} as InferenceConfig);
  const type = (override?.backend || s.backend || c.type || "openrouter") as keyof typeof BACKENDS;
  const be = BACKENDS[type] || BACKENDS.openrouter;
  const baseUrl = (s.baseUrl || c.baseUrl || be.defaultBaseUrl || "").replace(/\/+$/, "");
  return {
    type: be.id,
    backend: be,
    apiKey: s.key || c.apiKey || "",
    model: override?.model || s.model || c.model || be.defaultModel,
    baseUrl,
    headers: c.headers || {},
    temperature: c.temperature,
    keyFromConfig: !s.key && !!c.apiKey,
    modelFromConfig: !s.model && !!c.model,
    backendFromConfig: !s.backend && !!c.type
  };
}

export function ready(override?: Override): { ok: boolean; why?: string } {
  const r = resolve(override);
  if (r.backend.needsKey && !r.apiKey) return { ok: false, why: "No " + r.backend.label + " key yet — Menu → Settings." };
  if (!r.model) return { ok: false, why: "No model chosen — Menu → Settings." };
  return { ok: true };
}

/** The single entry point every feature uses. Every call is recorded on the
 *  run transcript (services/transcript.ts) — the "what is it doing" answer
 *  for journal, distill, exam and chat calls alike. */
export function chat(messages: ChatMessage[], opts: ChatOpts = {}, override?: Override): Promise<string> {
  const r = resolve(override);
  const check = ready(override);
  if (!check.ok) return Promise.reject(new Error(check.why));
  if (opts.temperature == null && r.temperature != null) opts.temperature = r.temperature;

  const started = Date.now();
  let usage: TokenUsage | undefined;
  const passedOnUsage = opts.onUsage;
  const wrapped: ChatOpts = {
    ...opts,
    onUsage: (u) => {
      usage = u;
      passedOnUsage?.(u);
    }
  };

  /* Kicked off, not awaited: the catalogue is memoised and cached for a day,
     so by the time a reply lands it has almost always resolved and the call
     can be priced. A call that beats it just records tokens without cost. */
  void loadPricing();

  const label = opts.label || "chat";

  /* The ledger is a bystander — a failure here must never take down an AI
     call that otherwise worked. */
  const meter = (failed: boolean) => {
    try {
      usageLog.add({
        at: started,
        backend: r.type,
        model: r.model,
        label,
        usage,
        /* The provider's own figure first. It is what was actually charged,
           and it is the only one that includes non-token fees — a web search
           costs about $0.007 that no tokens-times-price sum can account for. */
        cost: usage?.reportedCost ?? costOf(usage, priceForModel(r.type, r.model)),
        failed
      });
    } catch {
      /* ignore */
    }
  };

  return r.backend.chat(messages, wrapped, r).then(
    (res) => {
      transcript.record({
        at: started,
        label,
        model: r.model,
        messages: forTranscript(messages),
        response: res,
        error: null,
        usage,
        elapsedMs: Date.now() - started
      });
      meter(false);
      return res;
    },
    (err: unknown) => {
      if (!isAbort(err)) {
        transcript.record({
          at: started,
          label,
          model: r.model,
          messages: forTranscript(messages),
          response: null,
          error: (err as Error)?.message || String(err),
          usage,
          elapsedMs: Date.now() - started
        });
        meter(true);
      }
      throw err;
    }
  );
}

/* ------------------------------------------------------- one-shot calls -- */

/** What the budget planner needs to know about the model a call will reach. */
function describeModel(override?: Override): StructuredEnv {
  const r = resolve(override);
  return {
    backend: r.type,
    model: r.model,
    verdict: thinkingSupport(r.model).verdict,
    maxOutput: catalogueEntry(r.model)?.maxOutput
  };
}

/** Every one-shot operation below goes through this rather than calling chat()
 *  with a fixed max_tokens: sized for the model it reaches, and given one more
 *  go with more room when the reply was cut off. See services/ai/structured.ts. */
const structured = makeStructured<Override>(chat, describeModel);

/** The first attempt's room on its own, for the two garnish calls — titles and
 *  follow-ups — that already fail soft and are not worth a second request. */
function firstRoom(answerTokens: number, override?: Override): number {
  const m = describeModel(override);
  return planBudget({ answerTokens, verdict: m.verdict, backend: m.backend, maxOutput: m.maxOutput, attempt: 1 }).maxTokens;
}

export function listModels(override?: Override): Promise<string[]> {
  const r = resolve(override);
  return r.backend.listModels(r);
}

/* -------------------------------------------------------------- listening */

/** A hosted voice: which backend, which of its speech models, which voice. */
export interface SpeakTarget {
  engine: Exclude<SpeechEngineId, "device">;
  model: string;
  voice: string;
}

export interface Spoken extends SpeechClip {
  chars: number;
  /** undefined when the voice has no published price — unknown, not free. */
  cost?: number;
}

export interface SpeechCreds {
  apiKey: string;
  baseUrl: string;
  headers: Record<string, string>;
  /** Something about this backend has been set up here: it is the one chat
   *  uses, or a key or base URL was saved for it, or the config file names
   *  it. What decides whether a custom server is worth offering a voice for. */
  configured: boolean;
}

/**
 * The credentials saved for one backend, whether or not chat is using it.
 *
 * resolve() reads the live fields, which belong to whichever backend chat is
 * pointed at. Listening may use a different one — Groq for fast replies,
 * OpenRouter's voices to hear them — so this also reads the vault that
 * store.setBackend() fills. It never moves `settings.backend`; only
 * setBackend may do that.
 */
export function speechCreds(id: BackendType): SpeechCreds {
  const s = store.settings();
  const c = CFG.get().inference || ({} as InferenceConfig);
  const active = (s.backend || c.type || "openrouter") as BackendType;
  const saved = id === active ? { key: s.key, baseUrl: s.baseUrl } : s.creds?.[id];
  /* The config file names one backend. Its key belongs to this backend only
     if this is the one it names — or it names none, and this is the backend
     chat falls back to. */
  const fromConfig = c.type ? c.type === id : id === active;
  const be = BACKENDS[id];
  return {
    apiKey: saved?.key || (fromConfig ? c.apiKey || "" : ""),
    baseUrl: (saved?.baseUrl || (fromConfig ? c.baseUrl : "") || be?.defaultBaseUrl || "").replace(/\/+$/, ""),
    headers: fromConfig ? c.headers || {} : {},
    configured: id === active || !!saved?.key || !!saved?.baseUrl || (!!c.type && c.type === id)
  };
}

export function speechReady(id: BackendType): { ok: boolean; why?: string } {
  const be = BACKENDS[id];
  if (!be?.speech) return { ok: false, why: `${be?.label || id} cannot read aloud.` };
  if (be.needsKey && !speechCreds(id).apiKey) {
    return { ok: false, why: `No ${be.label} key yet — add one under Settings → Connection.` };
  }
  return { ok: true };
}

/**
 * Turn text into audio: the one place a voice is paid for.
 *
 * The listening counterpart of chat(). Every request goes on the run
 * transcript, and every one that returns goes in the usage ledger under
 * "listen", with its characters and its cost at the price in effect now. A
 * request stopped before it came back is recorded nowhere, the same as a chat
 * reply that was stopped.
 */
export async function speak(input: string, target: SpeakTarget, signal?: AbortSignal): Promise<Spoken> {
  const def = BACKENDS[target.engine]?.speech;
  const check = speechReady(target.engine);
  if (!def || !check.ok) throw new Error(check.why || "This backend cannot read aloud.");

  /* Waited for, not kicked off: the cost is frozen when the ledger row is
     written, and a price that lands a moment later is too late to count. The
     list is cached for a day, so this is almost always already resolved. */
  if (def.source === "catalogue") await loadSpeechCatalogue();

  const creds = speechCreds(target.engine);
  const ctx: AIContext = { apiKey: creds.apiKey, model: target.model, baseUrl: creds.baseUrl, headers: creds.headers };
  const started = Date.now();
  const chars = input.length;
  const perChar = speechPriceFor(target.engine, target.model);
  const cost = perChar == null ? undefined : perChar * chars;
  const label = "listen";

  const meter = (failed: boolean) => {
    try {
      usageLog.add({
        at: started,
        backend: target.engine,
        model: target.model,
        label,
        characters: failed ? 0 : chars,
        cost: failed ? undefined : cost,
        failed
      });
    } catch {
      /* the ledger is a bystander */
    }
  };

  try {
    const clip = await def.synthesize({ model: target.model, voice: target.voice, input, signal }, ctx);
    transcript.record({
      at: started,
      label,
      model: target.model,
      messages: [{ role: "user", content: input }],
      response: `[${U.fmtBytes(clip.audio.byteLength)} of ${clip.mime} · voice ${target.voice}${clip.generationId ? " · " + clip.generationId : ""}]`,
      error: null,
      elapsedMs: Date.now() - started
    });
    meter(false);
    return { ...clip, chars, cost };
  } catch (err) {
    if (!isAbort(err)) {
      transcript.record({
        at: started,
        label,
        model: target.model,
        messages: [{ role: "user", content: input }],
        response: null,
        error: (err as Error)?.message || String(err),
        elapsedMs: Date.now() - started
      });
      meter(true);
    }
    throw err;
  }
}

/** A connectivity probe, not a real prompt — but it still has to survive a
 *  reasoning model. 16 tokens used to be the whole budget, which is plenty
 *  for a model that just says "ready" and fatal for one that reasons first:
 *  the thinking spends the cap and the reply comes back empty, so a perfectly
 *  valid key/URL/model reported "hit the token cap" as if the connection were
 *  broken. Free reasoning models are exactly what OpenRouter's own note steers
 *  people toward, so this was not an edge case. */
export function test(): Promise<string> {
  return chat([{ role: "user", content: "Reply with the single word: ready" }], { temperature: 0, maxTokens: 800, label: "test" });
}

/* ------------------------------------------------------------ card writing */

const STYLE_RULES =
  "You write spaced-repetition flashcards for a self-taught learner going deep on mathematics and machine learning.\n\n" +
  "HOUSE STYLE\n" +
  "- One idea per card. If a card needs the word 'and', it is probably two cards. This is the minimum information principle and it is the single thing that decides whether a card survives.\n" +
  "- The front is a prompt to recall, not a quiz with options. Short. Often just a symbol, an instruction to write a formula, or a 'why does this work' question.\n" +
  "- The back is the shortest thing that would rebuild the idea in someone's head. Answer first, then one line on why it matters or the trap people fall into, wrapped in <em>.\n" +
  "- Favour why-questions, what-breaks-if-not, and tracing shapes over plain definitions.\n" +
  "- Plain prose, no filler, no praise, no exclamation marks.\n\n" +
  "FORMAT\n" +
  'Back may use only: <p>, <strong>, <em>, <code>, <var>, <sub>, <sup>, <div class="formula"> for a centred formula, and <div class="shape"> for code, array shapes or literal output (real newlines inside are preserved).\n' +
  "Front may use only <code> and <strong>.\n\n" +
  "MATHS\n" +
  "Write every expression as LaTeX, never as typed-out symbols. Inline maths goes in single dollars — $\\alpha$, " +
  "$x^{(i)}$ — and a displayed formula goes inside a formula div as bare LaTeX with no dollars:\n" +
  '<div class="formula">J(w,b) = \\frac{1}{2m} \\sum_{i=0}^{m-1} \\left( f(x^{(i)}) - y^{(i)} \\right)^2</div>\n' +
  "Use \\frac for every fraction. Never write a fraction as 1/2m, as <sup>1</sup>/<sub>2m</sub>, or with unicode " +
  "superscripts — those are unreadable at a glance, which defeats the point of the card.\n\n" +
  "OUTPUT\n" +
  "Return ONLY a JSON array. No prose around it, no code fence.\n" +
  '[{"tag":"Short section name","q":"front","a":"<p>back</p>"}]';

/** Models wrap JSON in fences, in apologies, in both. Cut to the array. */
function parseCards(txt: string): Card[] {
  let s = String(txt || "").trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error("The model did not return a card list. It said: " + s.slice(0, 220));
  let arr: unknown;
  try {
    arr = JSON.parse(s.slice(a, b + 1));
  } catch (e) {
    throw new Error("Could not read the card list back (" + (e as Error).message + "). Try again, or a stronger model.");
  }
  if (!Array.isArray(arr)) throw new Error("Expected a list of cards.");
  const out = (arr as Record<string, unknown>[])
    .filter((c) => c && c.q && c.a)
    .map((c) => store.normCard({ tag: c.tag as string, q: c.q as string, a: c.a as string }));
  if (!out.length) throw new Error("No usable cards came back.");
  return out;
}

/**
 * Prepend the shared learner brief to a system prompt.
 *
 * Until this existed, memory reached chat and nothing else — the card writer,
 * the recall marker and the exam generator all ran with no idea who they were
 * writing for, and `project.goals` was read by exactly one function despite
 * `core.ts:74` promising it on every turn. Every entry point below now scores
 * the same pool against its own natural query text.
 */
function withMemory(sys: string, queryText: string, opts: BriefOpts = {}): string {
  return memoryBrief({ queryText, recordUse: true, ...opts }).text + sys;
}

/** Show the model a few of your existing cards so new ones land in the same
 *  voice instead of reading like a textbook glossary. */
function styleSystem(): string {
  const ex = store
    .deck()
    .cards.slice(0, 3)
    .map((c) => ({ tag: c.tag, q: c.q, a: c.a }));
  return STYLE_RULES + (ex.length ? "\n\nMATCH THE STYLE OF THESE EXISTING CARDS:\n" + JSON.stringify(ex) : "");
}

export function generateCards(mode: "topic" | "notes", payload: string, n: number | string, focus?: string): Promise<Card[]> {
  const user =
    (mode === "topic"
      ? "Write " + n + " cards on: " + payload
      : "Turn this into " + n + " cards. Keep what is worth remembering, drop the filler.\n\nSOURCE:\n" + payload) +
    (focus ? "\n\nExtra instruction: " + focus : "");
  const sys = withMemory(styleSystem(), payload + " " + (focus || ""));
  return structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    label: "cards",
    what: "card writer",
    answerTokens: 4096,
    temperature: 0.5,
    parse: parseCards
  });
}

export function splitCard(card: Card, lapses?: number): Promise<Card[]> {
  const usr =
    "This card keeps being forgotten (" +
    (lapses || 0) +
    " lapses). Rewrite it as 2 to 4 atomic cards that together carry the same content, each asking for one thing only. Keep the same section tag.\n\n" +
    "FRONT:\n" +
    card.q +
    "\n\nBACK:\n" +
    card.a;
  const sys = withMemory(styleSystem(), card.q + " " + card.a);
  return structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    label: "split card",
    what: "card splitter",
    answerTokens: 3072,
    temperature: 0.4,
    parse: parseCards
  });
}

/* ------------------------------------------------------------ recall marking */

const MARK_SYS =
  "You mark a learner's attempt at recalling a flashcard. Be strict but fair: reward the idea, not the wording. " +
  'Reply ONLY with JSON: {"grade":1|2|3|4,"verdict":"got"|"partial"|"missed","missing":["short phrase",...],"note":"one short sentence"}. ' +
  "grade 1 = nothing right, 2 = the gist with real gaps or a wrong part, 3 = correct, 4 = correct and complete with no hesitation markers. " +
  "missing lists only what they left out or got wrong, at most three items, each under twelve words. " +
  "note is one sentence of the single most useful correction, or the one thing worth noticing if they got it right.";

function parseMarkResult(out: string): MarkResult {
  let j: MarkResult | null = null;
  try {
    j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  } catch {
    /* handled below */
  }
  if (!j || !j.verdict) throw new Error("unclear reply");
  j.grade = U.clamp(parseInt(String(j.grade), 10) || 2, 1, 4) as MarkResult["grade"];
  j.missing = Array.isArray(j.missing) ? j.missing.filter((x): x is string => typeof x === "string") : [];
  j.note = typeof j.note === "string" ? j.note : "";
  return j;
}

/** What this learner has already got wrong on this exact card. */
export interface RecallHistory {
  /** Times this card has been failed outright. */
  lapses: number;
  /** What the marker said was missing, on previous attempts at this card. */
  priorMisses: string[];
}

export async function markRecall(card: Card, attempt: string, history?: RecallHistory): Promise<MarkResult> {
  /* A repeated mistake is a different thing from a fresh one, and saying so
     is most of how it gets fixed — so the marker is shown what it said last
     time rather than meeting every attempt as if it were the first. */
  const prior =
    history && (history.lapses > 0 || history.priorMisses.length)
      ? "\n\nTHEIR HISTORY WITH THIS CARD:\n" +
        (history.lapses > 0 ? `Failed outright ${history.lapses} time${history.lapses === 1 ? "" : "s"} before.\n` : "") +
        (history.priorMisses.length
          ? "Previously missed:\n" + history.priorMisses.map((m) => "- " + m).join("\n") + "\n"
          : "") +
        "If they are making the same mistake again, say so in `note` — naming a repeat is worth more than " +
        "marking it fresh. If they have fixed something they used to miss, say that instead."
      : "";
  const usr =
    "CARD FRONT:\n" +
    U.stripTags(card.q) +
    "\n\nCARD BACK (the truth):\n" +
    U.stripTags(card.a) +
    "\n\nTHEIR ATTEMPT:\n" +
    attempt +
    prior;
  const sys = withMemory(MARK_SYS, U.stripTags(card.q) + " " + U.stripTags(card.a));
  return structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    label: "mark recall",
    what: "recall marker",
    answerTokens: 512,
    temperature: 0.1,
    parse: parseMarkResult
  });
}

/* ---------------------------------------------------------------- shared JSON parsing */

/**
 * Get an object or an array out of whatever the model actually sent.
 *
 * Four things go wrong in practice, and all four used to surface as the same
 * useless "did not return usable JSON. It said:" with nothing after the colon:
 *
 *   1. a reasoning model emits a <think> scratchpad first (and sometimes
 *      never closes the tag);
 *   2. the JSON arrives fenced, in the middle of a sentence rather than at
 *      the start of the reply;
 *   3. the reply is empty, because the token cap was spent on reasoning —
 *      which is a settings problem, not a parsing one;
 *   4. the JSON is well-formed apart from a trailing comma.
 *
 * Each is handled, and each failure now says which one happened.
 */
function extractJSON<T>(text: string, opener: "{" | "[" = "{"): T {
  const closer = opener === "{" ? "}" : "]";
  let s = String(text || "").trim();

  // The scratchpad, closed or not.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();

  // A fence anywhere, not only wrapping the whole reply.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();

  if (!s) {
    throw new Error(
      "The model replied with nothing at all. Usually the token cap was spent before it started writing — " +
        "common with reasoning models. Try a different model in Settings, or one with reasoning turned off."
    );
  }

  const a = s.indexOf(opener);
  const b = s.lastIndexOf(closer);
  if (a < 0 || b < a) {
    throw new Error("The model did not return usable JSON. It said: " + s.slice(0, 220));
  }

  const body = s.slice(a, b + 1);
  try {
    return JSON.parse(body) as T;
  } catch (e) {
    // One repair pass: a trailing comma before a closing brace or bracket is
    // the single most common way a model's JSON is otherwise perfect.
    try {
      return JSON.parse(body.replace(/,\s*([}\]])/g, "$1")) as T;
    } catch {
      /* fall through to the honest error */
    }
    throw new Error("The model's JSON would not parse (" + (e as Error).message + "). It said: " + body.slice(0, 220));
  }
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
}

export const MEMORY_TYPES: MemoryType[] = ["profile", "preference", "goal", "convention", "understanding", "open", "reference"];
export function normMemType(v: unknown): MemoryType {
  const s = String(v || "").toLowerCase();
  return (MEMORY_TYPES.find((t) => t === s) as MemoryType) || "understanding";
}

/* ------------------------------------------------------------- wrap up -- */

/* Deliberately stricter than DISTILL_SYS. Distilling runs over a journal entry
   the learner already curated; this runs over a raw conversation, where most
   of the text is the model's own explaining. Told to be generous it will
   happily turn a transcript into twenty memories. */
const WRAPUP_SYS =
  "Below is a conversation between a learner and their tutor. Extract only what is worth remembering about " +
  "THE LEARNER, months from now.\n\n" +
  "Prefer few and sharp — most conversations yield one to three items, and many yield none. Record how they " +
  "think, what framing finally worked, what they have settled on, and what they raised and left unresolved. " +
  "Do not record the subject matter itself: an explanation of backpropagation belongs in a card, not in " +
  "memory. Never record what the app can compute — which cards are failing, how many are due, streaks.\n\n" +
  "Do not repeat or closely restate anything in the ALREADY KNOWN list.\n\n" +
  "`type` is one of: profile, preference, goal, convention, understanding, open, reference. `scope` is " +
  '"global" only for facts true of them everywhere, otherwise "project". `stated` is true only when the ' +
  "learner asserted the fact themselves rather than you inferring it from how the conversation went.\n\n" +
  "If nothing durable came up, reply with an empty items list. That is a correct and common answer.\n\n" +
  'Reply ONLY with JSON: {"items":[{"scope":"...","type":"...","text":"...","stated":false}]}';

export interface WrapUpItem {
  scope: MemoryScope;
  type: MemoryType;
  text: string;
  stated: boolean;
}

/**
 * Extract memory from a conversation, for the explicit `/remember` path.
 *
 * The caller slices the transcript at the conversation's `rolledUpThrough` —
 * another field designed for this and never used — so asking twice does not
 * re-mine ground already covered.
 */
export async function wrapUp(turns: ChatMessage[], alreadyKnown: string[] = []): Promise<WrapUpItem[]> {
  if (!turns.length) return [];
  const transcript = turns.map((t) => (t.role === "user" ? "LEARNER: " : "TUTOR: ") + t.content).join("\n\n");
  const usr =
    (alreadyKnown.length
      ? "ALREADY KNOWN (do not repeat or closely restate):\n" +
        alreadyKnown.slice(0, 60).map((t) => "- " + t).join("\n") +
        "\n\n"
      : "") +
    "CONVERSATION:\n" +
    transcript;

  const sys = withMemory(WRAPUP_SYS, "", { memories: false });
  return structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    label: "wrap up",
    what: "memory extraction",
    answerTokens: 1200,
    temperature: 0.3,
    parse: (out) => {
      const j = extractJSON<{ items?: Record<string, unknown>[] }>(out);
      return (j.items || [])
        .filter((it) => it && typeof it.text === "string" && it.text.trim())
        .map((it) => ({
          scope: (it.scope === "global" ? "global" : "project") as MemoryScope,
          type: normMemType(it.type),
          text: String(it.text).trim(),
          stated: it.stated === true
        }));
    }
  });
}

/* -------------------------------------------------------------- journal -- */

const JOURNAL_SYS =
  "Write a learner's journal entry for one day.\n\n" +
  "You may be given two things, and they are not the same kind of evidence.\n\n" +
  "THE RECORD is what the app logged: cards reviewed and how each went, what they wrote from memory when " +
  "tested, conversations they worked in, exams, notes, cards written, figures they kept. It is fact. Use it for " +
  "`did`, and to ground everything else — but never read a difficulty into it that they did not express. A " +
  "failed card is a fact; what confused them about it is only knowable if they said so, or if the words they " +
  "wrote when tested show it.\n\n" +
  "THEIR OWN WORDS are what they typed, possibly messy and out of order. This is how they were thinking, and it " +
  "outranks the record everywhere the two could disagree about meaning.\n\n" +
  "If only one of the two is present, write from it alone and do not remark on the absence of the other.\n\n" +
  "`narrative` is 2 to 5 sentences in second person — the shape of the day, not a list. Be concrete and do not " +
  "flatter. If the day was thin, say so briefly rather than inflating it.\n\n" +
  "`stuck` is the most important field: capture the SPECIFIC confusion, not the topic. \"Could not see why the " +
  "chain rule gives that ordering\" beats \"struggled with backprop\". Leave empty rather than inventing " +
  "difficulty.\n\n" +
  "`open` is anything raised and not resolved — a question asked and dropped, a thing they said they would look " +
  "up. Leave empty rather than padding.\n\n" +
  "Use only what you are given. Do not add facts, do not correct their understanding, do not teach.\n\n" +
  "Reply ONLY with JSON: {\"narrative\":\"...\",\"did\":[\"...\"],\"learned\":[\"...\"],\"stuck\":[\"...\"]," +
  "\"open\":[\"...\"],\"resources\":[{\"label\":\"...\",\"url\":\"...\"}],\"nextUp\":[\"...\"]}";

/**
 * Write up one day.
 *
 * `record` is the day as the app logged it — `lib/dayBrief.ts`'s rendering of
 * it, passed in rather than imported, because that module reaches into every
 * store and this file is in the review loop's entry chunk (see the note on
 * `poolFor` in lib/chatContext.ts). The journal view is lazy and can afford
 * it; this cannot.
 *
 * It matters because the journal used to be written from the capture box
 * alone. A day spent drilling sixty cards, arguing through a derivation in
 * chat and sitting an exam produced "Log something first" — the one section
 * whose job is to say what happened could not see anything that had.
 */
export async function writeJournal(rawText: string, project: Project, record?: string): Promise<JournalSummary> {
  const usr =
    "PROJECT: " + project.name + (project.goals ? " — goal: " + project.goals : "") +
    (record ? "\n\nTHE RECORD — what the app logged for this day:\n" + record : "") +
    (rawText.trim() ? "\n\nTHEIR OWN WORDS, as they typed them:\n" + rawText : "");
  const sys = withMemory(JOURNAL_SYS, rawText, { goals: false, projectId: project.id });
  const j = await structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    label: "journal",
    what: "journal writer",
    answerTokens: 1600,
    temperature: 0.4,
    parse: (out) => extractJSON<Partial<JournalSummary> & { resources?: unknown }>(out)
  });
  const resources = Array.isArray(j.resources)
    ? (j.resources as Record<string, unknown>[])
        .filter((r) => r && (r.label || r.url))
        .map((r) => ({ label: String(r.label || r.url || ""), url: String(r.url || "") }))
    : [];
  return {
    narrative: String(j.narrative || "").trim(),
    did: strArr(j.did),
    learned: strArr(j.learned),
    stuck: strArr(j.stuck),
    open: strArr(j.open),
    resources,
    nextUp: strArr(j.nextUp),
    generatedBy: { model: resolve().model, at: Date.now() }
  };
}

/* -------------------------------------------------------------- distill -- */

const DISTILL_SYS =
  "From this journal entry, produce two things.\n\n" +
  "Memories: only what is durable. Prefer few and sharp. Never record what can be computed from review history — " +
  "which cards are failing, how many are due, streaks. Record how the learner thinks, what framing works, what " +
  "they have settled on, and what they left unresolved. Each memory has a `type`: profile, preference, goal, " +
  "convention, understanding, open, or reference — `understanding` from things learned, `open` from things left " +
  "unresolved, `goal`/`convention` only when the entry actually states one. Do not propose a memory that " +
  "duplicates or closely restates one already captured, listed below.\n\n" +
  "Cards: weighted toward stuck and learned. Every card must be atomic (one fact — if the answer needs \"and\", " +
  "it is two cards), self-contained (answerable in six months with no memory of today — no \"the trick\", \"the " +
  "paper\", \"as discussed\"), and demand recall rather than recognition (never yes/no or pick-from-list). If a " +
  "draft card fails any of these, rewrite it before returning it. Do not propose a card that duplicates one of " +
  "the existing cards listed below.\n\n" +
  'Reply ONLY with JSON: {"memories":[{"type":"...","text":"..."}],"cards":[{"tag":"...","q":"...","a":"<p>...</p>"}]}';

export interface DistillResult {
  memories: { type: MemoryType; text: string }[];
  cards: Card[];
}

export async function distill(
  entry: JournalEntry,
  project: Project,
  existingCards: { tag: string; q: string }[],
  existingMemoryTexts: string[] = []
): Promise<DistillResult> {
  const s = entry.summary;
  if (!s) throw new Error("Generate the journal narrative before distilling.");
  const usr = [
    "PROJECT: " + project.name,
    "NARRATIVE:\n" + s.narrative,
    s.learned.length ? "LEARNED:\n" + s.learned.map((x) => "- " + x).join("\n") : "",
    s.stuck.length ? "STUCK:\n" + s.stuck.map((x) => "- " + x).join("\n") : "",
    s.open.length ? "OPEN:\n" + s.open.map((x) => "- " + x).join("\n") : "",
    existingCards.length
      ? "EXISTING CARDS (do not duplicate):\n" + existingCards.slice(0, 100).map((c) => `- (${c.tag}) ${U.stripTags(c.q)}`).join("\n")
      : "",
    existingMemoryTexts.length
      ? "ALREADY CAPTURED AS MEMORY OR PROPOSED (do not repeat these or close restatements):\n" +
        existingMemoryTexts.slice(0, 60).map((t) => "- " + t).join("\n")
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");
  const sys = withMemory(DISTILL_SYS, "", { memories: false, projectId: project.id });
  const j = await structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    label: "distill",
    what: "distill",
    answerTokens: 2600,
    temperature: 0.4,
    parse: (out) => extractJSON<{ memories?: Record<string, unknown>[]; cards?: Record<string, unknown>[] }>(out)
  });
  const memories = (j.memories || [])
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({ type: normMemType(m.type), text: String(m.text).trim() }));
  const cards = (j.cards || [])
    .filter((c) => c && c.q && c.a)
    .map((c) => store.normCard({ tag: c.tag as string, q: c.q as string, a: c.a as string }));
  return { memories, cards };
}

/* ---------------------------------------------------------- weekly rollup */

const ROLLUP_SYS =
  "These are a learner's daily journal entries for this period. Write the period summary: the themes that " +
  "actually recurred, what changed in their understanding, and what is still open. Then propose updates to " +
  "project memory: new entries worth keeping, merges of entries that are now known to be the same thing, and " +
  "retirements of anything these entries have superseded. Invent nothing not present in the entries. Propose at " +
  "most twelve memory changes — the ones that matter most, not every one that is possible.\n\n" +
  "Memories marked [PINNED] are off limits: never merge them, never retire them. Reference only ids that appear " +
  "in the list below — a diff line naming an id that is not there does nothing at all.\n\n" +
  'Reply ONLY with JSON: {"narrative":"...","themes":["..."],"stillOpen":["..."],' +
  '"diff":[{"kind":"add","type":"...","text":"..."},{"kind":"merge","from":["memoryId",...],"text":"..."},' +
  '{"kind":"retire","id":"memoryId","reason":"..."}]}';

export interface RollupResult {
  narrative: string;
  themes: string[];
  stillOpen: string[];
  diff: MemoryDiffLine[];
}

function normalizeDiffLine(raw: unknown): MemoryDiffLine | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== "object") return null;
  if (r.kind === "add" && typeof r.text === "string" && r.text.trim()) {
    return { kind: "add", type: normMemType(r.type), text: r.text.trim() };
  }
  if (r.kind === "merge" && Array.isArray(r.from) && typeof r.text === "string" && r.text.trim()) {
    const from = r.from.filter((x): x is string => typeof x === "string");
    if (from.length) return { kind: "merge", from, text: r.text.trim() };
  }
  if (r.kind === "retire" && typeof r.id === "string" && r.id) {
    return { kind: "retire", id: r.id, reason: typeof r.reason === "string" ? r.reason : "" };
  }
  return null;
}

export async function rollup(entries: JournalEntry[], project: Project, existingMemories: Memory[]): Promise<RollupResult> {
  const usr = [
    "PROJECT: " + project.name,
    "ENTRIES:\n" +
      entries
        .map((e) => {
          const s = e.summary!;
          return `--- ${e.day} ---\n${s.narrative}\nLearned: ${s.learned.join("; ")}\nStuck: ${s.stuck.join("; ")}\nOpen: ${s.open.join("; ")}`;
        })
        .join("\n\n"),
    existingMemories.length
      ? "EXISTING PROJECT MEMORY (reference by id when merging/retiring):\n" +
        [...existingMemories]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_CONSOLIDATE)
          .map(memoryLine)
          .join("\n")
      : ""
  ]
    .filter(Boolean)
    .join("\n\n");
  const j = await structured({
    messages: [{ role: "system", content: ROLLUP_SYS }, { role: "user", content: usr }],
    label: "rollup",
    what: "weekly rollup",
    answerTokens: 2400,
    temperature: 0.4,
    parse: (out) => extractJSON<{ narrative?: string; themes?: unknown; stillOpen?: unknown; diff?: unknown[] }>(out)
  });
  const diff = Array.isArray(j.diff) ? (j.diff.map(normalizeDiffLine).filter((x): x is MemoryDiffLine => !!x)) : [];
  return { narrative: String(j.narrative || "").trim(), themes: strArr(j.themes), stillOpen: strArr(j.stillOpen), diff };
}

/** How a memory is shown to a model that may propose merging or retiring it.
 *  The id is what a diff line has to reference, and [PINNED] marks the ones the
 *  learner asked to keep. memoryStore.retire() refuses a pinned id anyway, but
 *  a proposal the learner has to notice and reject is already a bad proposal. */
function memoryLine(m: Memory): string {
  return `- [${m.id}]${m.pinned ? " [PINNED]" : ""} (${m.type}) ${m.text}`;
}

/** Past roughly this many entries, ids start coming back wrong — a model runs
 *  out of attention for copying verbatim strings long before it runs out of
 *  context window. Consolidation sees the most recently changed slice; the rest
 *  keep their turn on the next pass. */
const MAX_CONSOLIDATE = 80;

const CONSOLIDATE_SYS =
  "Below is a learner's current memory for one project. Tidy it: merge entries that say the same thing, retire " +
  "anything stale or superseded, and leave everything else alone. Do not invent new memory — only merges and " +
  "retirements of what is listed. Memories marked [PINNED] are off limits: never merge or retire them. " +
  "Reference only ids that appear below. If nothing needs changing, return an empty diff.\n\n" +
  'Reply ONLY with JSON: {"diff":[{"kind":"merge","from":["memoryId",...],"text":"..."},' +
  '{"kind":"retire","id":"memoryId","reason":"..."}]}';

export async function consolidateMemory(memories: Memory[], project: Project): Promise<MemoryDiffLine[]> {
  const shown = [...memories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONSOLIDATE);
  const usr = "PROJECT: " + project.name + "\n\nMEMORY:\n" + shown.map(memoryLine).join("\n");
  const j = await structured({
    messages: [{ role: "system", content: CONSOLIDATE_SYS }, { role: "user", content: usr }],
    label: "consolidate",
    what: "memory tidy-up",
    answerTokens: 1600,
    temperature: 0.3,
    parse: (out) => extractJSON<{ diff?: unknown[] }>(out)
  });
  return Array.isArray(j.diff) ? j.diff.map(normalizeDiffLine).filter((x): x is MemoryDiffLine => !!x) : [];
}

/* ------------------------------------------------------------------ exam */

const EXAM_SYS =
  "Build an exam from the material below, weighted toward the requested level.\n\n" +
  "Do not simply restate flashcards. At least half the questions must span two or more sources — connect ideas " +
  "learned separately, apply something to a new case, derive a result from a stated convention, or diagnose an " +
  "error in a worked example. `kind` is one of: recall, apply, why, connect, derive, diagnose. `difficulty` is " +
  "one of: recall, apply, analyse, synthesise.\n\n" +
  "When a TOPIC is given, it is a hard boundary, not a hint: every question must be about it. If the material " +
  "below contains other subjects — it was found by keyword relevance and can carry noise — ignore anything that " +
  "is not actually about the topic rather than writing a question on it.\n\n" +
  "Every question carries `sourceRefs` naming exactly what it was built from — items are tagged [card:id] or " +
  "[journal:id] in the material. If you cannot ground a question in the material, do not write it. Fewer, " +
  "well-founded questions beat a full set with invented ones.\n\n" +
  "`expected` states what a correct answer must contain — the marking key, not a model answer.\n\n" +
  'Reply ONLY with a JSON array: [{"kind":"...","difficulty":"...","prompt":"...","expected":"...",' +
  '"sourceRefs":[{"kind":"card"|"journal","id":"..."}]}]';

const QUESTION_KINDS: QuestionKind[] = ["recall", "apply", "why", "connect", "derive", "diagnose"];
const DIFFICULTIES: Difficulty[] = ["recall", "apply", "analyse", "synthesise"];
function normKind(v: unknown): QuestionKind {
  return (QUESTION_KINDS.find((k) => k === v) as QuestionKind) || "recall";
}
function normDiff(v: unknown, fallback: Difficulty): Difficulty {
  return (DIFFICULTIES.find((d) => d === v) as Difficulty) || fallback;
}

export async function generateExam(material: string, level: Difficulty, exclude: string[], topic?: string): Promise<ExamQuestion[]> {
  const t = (topic || "").trim();
  const usr =
    "LEVEL: " +
    level +
    "\n\n" +
    (t ? "TOPIC: " + t + " — see the system rules on what this means.\n\n" : "") +
    (exclude.length ? "ALREADY ASKED (do not repeat these or close variants):\n" + exclude.map((x) => "- " + x).join("\n") + "\n\n" : "") +
    "MATERIAL:\n" +
    material;
  /* The topic, not the whole material blob, is what memory and gaps are
     scored against when one is given — otherwise "matplotlib" would retrieve
     memory for whatever else happened to ride along in the material, which
     defeats the point of naming a topic at all. */
  const sys = withMemory(EXAM_SYS, t || material);
  const j = await structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    label: "exam generation",
    what: "exam generator",
    answerTokens: 3200,
    temperature: 0.5,
    parse: (out) => extractJSON<Record<string, unknown>[]>(out, "[")
  });
  const out2 = (Array.isArray(j) ? j : []).filter((q) => q && typeof q.prompt === "string" && typeof q.expected === "string");
  if (!out2.length) throw new Error("No well-grounded questions came back. Try a wider scope.");
  return out2.map((q) => ({
    id: U.uuid(),
    kind: normKind(q.kind),
    difficulty: normDiff(q.difficulty, level),
    prompt: String(q.prompt),
    expected: String(q.expected),
    sourceRefs: Array.isArray(q.sourceRefs)
      ? (q.sourceRefs as Record<string, unknown>[])
          .filter((r) => r && (r.kind === "card" || r.kind === "journal" || r.kind === "memory") && r.id)
          .map((r) => ({ kind: r.kind as "card" | "journal" | "memory", id: String(r.id) }))
      : [],
    answer: null,
    result: null,
    answeredAt: null
  }));
}

const EXAM_MARK_SYS =
  "You mark a learner's attempt at an exam question that may span multiple ideas at once. Be strict but fair: " +
  "reward the idea, not the wording, and check specifically for what the marking key requires. " +
  'Reply ONLY with JSON: {"grade":1|2|3|4,"verdict":"got"|"partial"|"missed","missing":["short phrase",...],"note":"one short sentence"}. ' +
  "grade 1 = nothing right, 2 = the gist with real gaps or a wrong part, 3 = correct, 4 = correct and complete. " +
  "missing lists only what they left out or got wrong, at most three items, each under twelve words.";

export async function markExamAnswer(prompt: string, expected: string, attempt: string): Promise<MarkResult> {
  const usr = "QUESTION:\n" + prompt + "\n\nWHAT A CORRECT ANSWER MUST CONTAIN:\n" + expected + "\n\nTHEIR ANSWER:\n" + attempt;
  const sys = withMemory(EXAM_MARK_SYS, prompt + " " + expected);
  return structured({
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    label: "exam grading",
    what: "exam grader",
    answerTokens: 512,
    temperature: 0.1,
    parse: parseMarkResult
  });
}

/* ------------------------------------------------------------------ tutor */

export function tutorSystem(card: Card): string {
  const s = store.settings();
  let t = s.tutor || store.DEFAULT_TUTOR;
  if (s.lang === "hinglish") {
    t +=
      "\n\nWrite in natural Hinglish — Hindi and English mixed the way an Indian engineer explains to a friend — but keep every technical term, formula, symbol and code fragment in English.";
  }
  return (
    withMemory(t, U.stripTags(card.q) + " " + U.stripTags(card.a)) +
    "\n\nThe learner is drilling this flashcard.\nFRONT: " +
    card.q +
    "\nBACK: " +
    card.a
  );
}

/* ------------------------------------------------------- chat utilities -- */

/** Name a conversation from its opening exchange. Deliberately cheap: low
 *  temperature and truncated inputs — this runs on every new thread and
 *  nobody wants to pay tutor rates for a sidebar label.
 *
 *  The budget is not as tiny as it looks like it should be, and that is the
 *  point. It was 24 tokens: invisible to a model that answers in four words,
 *  and entirely spent on the scratchpad by a model that thinks first — which
 *  returned nothing, left the conversation untitled, and so tried again on
 *  the next message, and the one after. One unwanted request per thread had
 *  quietly become one per message. Returns "" when the reply still holds no
 *  title; lib/title's localTitle answers that, not a second call. */
export async function generateTitle(userMsg: string, assistantMsg: string, override?: Override): Promise<string> {
  const out = await chat(
    [
      {
        role: "system",
        content:
          "Write a title for this conversation: 2 to 5 words, no quotes, no trailing punctuation, " +
          "no filler like 'discussion about'. Name the actual subject. Reply with the title alone."
      },
      { role: "user", content: `USER: ${userMsg.slice(0, 800)}\n\nASSISTANT: ${assistantMsg.slice(0, 800)}` }
    ],
    { temperature: 0.2, maxTokens: firstRoom(192, override), label: "title" },
    override
  );
  return cleanTitle(out);
}

/** Three next questions worth asking. Returned as plain strings; a model that
 *  ignores the format yields an empty list and the UI simply shows nothing,
 *  which is the correct failure for a garnish feature. */
export async function suggestFollowups(
  messages: ChatMessage[],
  override?: Override,
  signal?: AbortSignal
): Promise<string[]> {
  const tail = messages.slice(-4);
  try {
    const out = await chat(
      [
        {
          role: "system",
          /* The brief without memory: the goals and — the point of this — what
             they are currently getting wrong. Follow-ups were generated from
             the last four messages alone, so the app's best suggestion for
             "what should I ask next" was made by the only call in the system
             that had no idea what the learner keeps failing. The tail is
             sliced before the system message, so it could not inherit it
             either. */
          content:
            memoryBrief({ memories: false }).text +
            "Given the end of a tutoring conversation, propose three follow-up questions the learner " +
            "should ask next. Favour questions that go deeper into the mechanism, probe an edge case, or " +
            "connect the idea to something adjacent — not questions already answered. Where one of their " +
            "standing gaps above is relevant to what is being discussed, aim a question at it. Each under " +
            "12 words, written in the learner's voice. Reply ONLY with a JSON array of three strings."
        },
        { role: "user", content: tail.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1200)}`).join("\n\n") }
      ],
      { temperature: 0.7, maxTokens: firstRoom(200, override), signal, label: "followups" },
      override
    );
    const a = out.indexOf("[");
    const b = out.lastIndexOf("]");
    if (a < 0 || b < a) return [];
    const arr = JSON.parse(out.slice(a, b + 1));
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 3);
  } catch {
    return [];
  }
}

/** Models answer in markdown however hard you ask for HTML. Convert the three
 *  things they actually use, then run it through the same sanitiser as cards. */
export function formatReply(t: string): string {
  let s = String(t || "");
  s = s.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_m, c) => '<div class="shape">' + U.esc(c.replace(/\s+$/, "")) + "</div>");
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => "<code>" + U.esc(c) + "</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  if (!/<p[\s>]/i.test(s)) {
    s = s
      .split(/\n{2,}/)
      .map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>")
      .join("");
  }
  return U.clean(s);
}
