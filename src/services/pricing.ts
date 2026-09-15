/* ============================================================================
 * pricing.ts — what a model costs, and what it can do.
 *
 * OpenRouter publishes per-token pricing for its whole catalogue on /models,
 * so one public, unauthenticated fetch prices every model it serves. That is
 * the whole reason there is no hand-maintained price table in this repo: a
 * bundled table would rot, and every new model would be a code edit.
 *
 * The same response carries `supported_parameters`, which is the only
 * machine-readable answer anywhere to "can this model think?". So the fetch
 * answers two questions and this file owns both — splitting capabilities into
 * their own module would mean pulling the same 300KB twice. Prices go out
 * through priceForModel (backend-gated, because a price is a claim about
 * money); capabilities go out through catalogueEntry (not gated, because the
 * model is the same model wherever you call it from).
 *
 * Which backends that applies to is the backend's own business, declared as
 * `pricing` on its BackendDef rather than decided by a list of ids here:
 *
 *   catalogue  look it up below
 *   free       nothing to pay — Ollama runs locally, Groq's tier is free
 *   unpriced   we do not know
 *
 * The third state used to be missing, and its absence was a real bug: the
 * custom backend was assumed local and hardcoded to $0, so pointing it at a
 * paid hosted API — the obvious thing to do with it — billed you and reported
 * every call as free.
 *
 * A model that matches nothing reports no price at all. Showing a fabricated
 * number would be worse than showing none.
 *
 * Cached in localStorage for a day: the list is ~300KB and changes rarely.
 * ========================================================================== */
import { BACKENDS } from "@/services/ai/backends";
import type { ModelPrice } from "@/types/chat";

/* v2 added `reasoning`; a v1 cache has the field missing rather than
   false, which would read as "cannot think" for every model in it. */
const CACHE_KEY = "drill:pricing:v2";
const STALE_KEYS = ["drill:pricing:v1"];
const TTL = 24 * 60 * 60 * 1000;
/** Hardcoded rather than taken from the resolved backend: this is fetched
 *  regardless of which backend is active, so the active base URL is usually
 *  pointing somewhere else entirely. */
const CATALOGUE = "https://openrouter.ai/api/v1/models";

/** Costs nothing. That is a fact about the backend, not a missing price, so
 *  it reads "$0" rather than "—". */
const FREE: ModelPrice = { id: "free", prompt: 0, completion: 0 };

interface Cache {
  at: number;
  models: Record<string, ModelPrice>;
}

let memo: Record<string, ModelPrice> | null = null;
let inflight: Promise<Record<string, ModelPrice>> | null = null;

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cache;
    if (!c || Date.now() - c.at > TTL) return null;
    return c;
  } catch {
    return null;
  }
}

/** Fetch the price catalogue. Runs for every backend, not just OpenRouter —
 *  see the header. Resolves to an empty map when the network says no, which
 *  is a normal outcome, not an error. */
export function loadPricing(): Promise<Record<string, ModelPrice>> {
  if (memo) return Promise.resolve(memo);
  if (inflight) return inflight;

  const cached = readCache();
  if (cached) {
    memo = cached.models;
    return Promise.resolve(memo);
  }

  inflight = fetch(CATALOGUE)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((j: { data?: unknown[] }) => {
      const models: Record<string, ModelPrice> = {};
      for (const raw of j.data || []) {
        const m = raw as {
          id?: string;
          name?: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string };
          supported_parameters?: string[];
          architecture?: { input_modalities?: string[] };
          top_provider?: { max_completion_tokens?: number | null };
        };
        if (!m.id || !m.pricing) continue;
        // OpenRouter quotes USD per token as a decimal string; we store per
        // million to keep the numbers legible.
        const prompt = parseFloat(m.pricing.prompt || "0") * 1e6;
        const completion = parseFloat(m.pricing.completion || "0") * 1e6;
        if (!isFinite(prompt) || !isFinite(completion)) continue;
        /* "reasoning" is the parameter you send to make a model think;
           "include_reasoning" only asks for the trace back. A model that
           advertises either one accepts the switch. */
        const params = m.supported_parameters || [];
        models[m.id] = {
          id: m.id,
          name: m.name,
          prompt,
          completion,
          contextLength: m.context_length,
          reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
          inputModalities: m.architecture?.input_modalities,
          maxOutput: m.top_provider?.max_completion_tokens || undefined
        };
      }
      memo = models;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), models } satisfies Cache));
      } catch {
        /* quota — pricing is a nicety, not worth failing over */
      }
      return models;
    })
    .catch(() => {
      memo = {};
      return memo;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Look up by catalogue id. Only correct for models already named the way
 *  OpenRouter names them; everything else should go through priceForModel. */
export function priceFor(modelId: string): ModelPrice | undefined {
  return memo ? memo[modelId] : undefined;
}

/** Vendors name the same model differently from the catalogue in two ways
 *  that are both mechanical:
 *
 *    dates    a model shipped as gpt-4o-2024-08-06 or claude-sonnet-4-5-20250929;
 *             the catalogue lists neither suffix.
 *    version  an API that separates the version with a hyphen
 *             (claude-sonnet-4-5) where the catalogue uses a dot
 *             (claude-sonnet-4.5).
 *
 *  Returns the ids worth trying, most specific first. */
function candidates(model: string): string[] {
  const undated = model.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  /* -4-5- → -4.5- , which also covers the older claude-3-5-sonnet shape. */
  const dotted = undated.replace(/-(\d)-(\d)(?=-|$)/, "-$1.$2");

  const out: string[] = [];
  for (const id of [model, undated, dotted]) {
    if (id && out.indexOf(id) < 0) out.push(id);
  }
  return out;
}

export function priceForModel(backend: string, model: string): ModelPrice | undefined {
  /* An unknown backend id is treated as unpriced, not as free. */
  const mode = BACKENDS[backend as keyof typeof BACKENDS]?.pricing ?? "unpriced";
  if (mode === "free") return FREE;
  if (mode !== "catalogue") return undefined;
  if (!memo || !model) return undefined;

  for (const id of candidates(model)) {
    const hit = memo[id];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The catalogue's record for a model, whatever backend you reach it through.
 *
 * Deliberately *not* gated on the backend's `pricing` mode the way
 * priceForModel is. That gate exists because quoting OpenRouter's price for a
 * call that went somewhere else would be a lie about money; there is no
 * equivalent lie here, because "llama-3.3-70b-instruct cannot think" is true
 * of the weights and stays true when Groq serves them.
 *
 * Returns undefined when the catalogue has never heard of the id, which is
 * the normal case for a local model — see lib/thinking.ts for what the UI
 * does with not-knowing.
 */
export function catalogueEntry(model: string): ModelPrice | undefined {
  if (!memo || !model) return undefined;
  for (const id of candidates(model)) {
    const hit = memo[id];
    if (hit) return hit;
  }
  return undefined;
}

/* ---------------------------------------------------------------- speech -- */

/* Speech models are a separate listing: /models leaves them out unless they
   are asked for by output modality. The listing is small — under twenty
   models — and trimmed to what is used before it is cached, because
   localStorage is the drawer the review log lives in. */
const SPEECH_CACHE_KEY = "drill:speech-models:v1";
const SPEECH_CATALOGUE = CATALOGUE + "?output_modalities=speech";
/** How long a failed fetch is left alone before trying again. Short, because
 *  "not loaded" keeps every voice usable anyway, and giving up for the day
 *  would leave every listen that day priced as unknown. */
const SPEECH_RETRY_MS = 60_000;

export interface SpeechModel {
  id: string;
  name?: string;
  /** USD per character, when the model bills by the character. Undefined for
   *  one billed some other way — Gemini's speech model counts audio tokens —
   *  which a character count cannot price, so it shows as unknown. */
  perChar?: number;
  /** The voices the model publishes. Empty means it publishes none. */
  voices: string[];
}

interface SpeechCache {
  at: number;
  models: Record<string, SpeechModel>;
}

let speechMemo: Record<string, SpeechModel> | null = null;
let speechInflight: Promise<Record<string, SpeechModel> | null> | null = null;
let speechFailedAt = 0;

/** Fetch the speech models and their voices. Resolves to null when the
 *  network says no — which callers read as "not known yet", never as "there
 *  are no speech models". */
export function loadSpeechCatalogue(): Promise<Record<string, SpeechModel> | null> {
  if (speechMemo) return Promise.resolve(speechMemo);
  if (speechInflight) return speechInflight;

  try {
    const raw = localStorage.getItem(SPEECH_CACHE_KEY);
    const c = raw ? (JSON.parse(raw) as SpeechCache) : null;
    if (c && c.models && Date.now() - c.at <= TTL) {
      speechMemo = c.models;
      return Promise.resolve(speechMemo);
    }
  } catch {
    /* an unreadable cache is a cache miss */
  }
  if (Date.now() - speechFailedAt < SPEECH_RETRY_MS) return Promise.resolve(null);

  speechInflight = fetch(SPEECH_CATALOGUE)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((j: { data?: unknown[] }) => {
      const models: Record<string, SpeechModel> = {};
      for (const raw of j.data || []) {
        const m = raw as {
          id?: string;
          name?: string;
          pricing?: { prompt?: string; completion?: string };
          supported_voices?: unknown;
        };
        if (!m.id) continue;
        /* Speech on OpenRouter is billed per character of input, and the
           catalogue carries that rate in `prompt` with `completion` at zero.
           A model with a non-zero completion rate is billed on its output
           instead, and no character count prices that honestly. */
        const prompt = parseFloat(m.pricing?.prompt ?? "");
        const completion = parseFloat(m.pricing?.completion ?? "0");
        models[m.id] = {
          id: m.id,
          name: m.name,
          perChar: Number.isFinite(prompt) && (!Number.isFinite(completion) || completion === 0) ? prompt : undefined,
          voices: Array.isArray(m.supported_voices)
            ? m.supported_voices.filter((v): v is string => typeof v === "string" && !!v)
            : []
        };
      }
      speechMemo = models;
      try {
        localStorage.setItem(SPEECH_CACHE_KEY, JSON.stringify({ at: Date.now(), models } satisfies SpeechCache));
      } catch {
        /* quota — the list is a nicety, and it is fetched again tomorrow */
      }
      return models;
    })
    .catch(() => {
      speechFailedAt = Date.now();
      return null;
    })
    .finally(() => {
      speechInflight = null;
    });

  return speechInflight;
}

/** The speech catalogue if it has loaded, otherwise null. */
export function speechCatalogue(): Record<string, SpeechModel> | null {
  return speechMemo;
}

/**
 * USD per character for a speech model reached through a backend.
 *
 * Gated on the backend's pricing mode exactly as priceForModel is: 0 for a
 * backend that costs nothing, a catalogue rate only for the catalogue's own
 * backend, and undefined — unknown, not free — for everything else.
 */
export function speechPriceFor(backend: string, model: string): number | undefined {
  const mode = BACKENDS[backend as keyof typeof BACKENDS]?.pricing ?? "unpriced";
  if (mode === "free") return 0;
  if (mode !== "catalogue") return undefined;
  return speechMemo?.[model]?.perChar;
}

export function clearPricing(): void {
  memo = null;
  speechMemo = null;
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(SPEECH_CACHE_KEY);
    for (const k of STALE_KEYS) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
