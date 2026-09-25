/* ============================================================================
 * pricing.ts — every model there is, what it costs, and what it can do.
 *
 * OpenRouter publishes its whole catalogue on /models, so one public,
 * unauthenticated fetch prices and describes every model it serves. That is
 * the reason there is no hand-maintained model table in this repo: a bundled
 * table would rot, and every new model would be a code edit.
 *
 * **It is fetched with `output_modalities=all`.** Unfiltered, /models means
 * text models only — 460 of 625 on 2026-09-25 — and for a year that was all
 * this app asked for. Every image-only generator, every video model, every
 * voice and every transcriber was missing from every picker, and the voice
 * list needed a second fetch of its own. One request now returns all of them,
 * and lib/models.ts turns each raw record into the one shape everything reads.
 *
 * The same response carries `supported_parameters`, which is the only
 * machine-readable answer anywhere to "can this model think?". So the fetch
 * answers two questions and this file owns both. Prices go out through
 * priceForModel (backend-gated, because a price is a claim about money);
 * capabilities go out through catalogueEntry (not gated, because the model is
 * the same model wherever you call it from). Which backends are priced is the
 * backend's own business, declared as `pricing` on its BackendDef:
 *
 *   catalogue  look it up below
 *   free       nothing to pay — Ollama runs locally, Groq's tier is free
 *   unpriced   we do not know
 *
 * A model that matches nothing reports no price at all. Showing a fabricated
 * number would be worse than showing none.
 *
 * **Cached in IndexedDB, served stale while it refreshes.** It lived in
 * localStorage — the drawer the review log has to fit in — and a cache older
 * than a day was thrown away before the fetch that replaced it, so a stale
 * cache offline was an empty picker. Now yesterday's catalogue is shown at
 * once and today's replaces it when it lands; see services/catalogueCache.ts.
 * A failed fetch is retried after a minute rather than leaving the session
 * with nothing, which is what the empty-map-forever fallback used to do.
 *
 * Two more listings, fetched only when Image or Video mode needs them:
 * /images/models and /videos/models, which say which dials each model takes
 * (lib/mediaCaps.ts).
 * ========================================================================== */
import { BACKENDS } from "@/services/ai/backends";
import { fromRaw, type RawModel } from "@/lib/models";
import { parseImageCaps, parseVideoCaps, type ImageCaps, type VideoCaps } from "@/lib/mediaCaps";
import { clearCached, readCached, writeCached } from "./catalogueCache";
import type { ModelKind, ModelPrice } from "@/types/chat";

const API = "https://openrouter.ai/api/v1";
/** Hardcoded rather than taken from the resolved backend: this is fetched
 *  regardless of which backend is active, so the active base URL is usually
 *  pointing somewhere else entirely. */
const CATALOGUE = API + "/models?output_modalities=all";
const TTL = 24 * 60 * 60 * 1000;
const RETRY_MS = 60_000;
/** Bumped when the stored shape changes, so an old cache reads as a miss
 *  rather than as models that "cannot think" or "cannot draw". */
const SHAPE = 6;

/** localStorage keys the catalogue used before it moved to IndexedDB. Removed
 *  on first load: they were a few hundred kilobytes of the review log's room. */
const RETIRED_KEYS = ["drill:pricing:v1", "drill:pricing:v2", "drill:pricing:v3", "drill:speech-models:v1"];

/** Costs nothing. That is a fact about the backend, not a missing price, so
 *  it reads "$0" rather than "—". */
const FREE: ModelPrice = { id: "free", prompt: 0, completion: 0 };

let memo: Record<string, ModelPrice> | null = null;
let fetchedAt = 0;
let inflight: Promise<Record<string, ModelPrice>> | null = null;
let failedAt = 0;
let revalidating = false;
let retiredOnce = false;

let version = 0;
const listeners = new Set<() => void>();
function notify(): void {
  version++;
  listeners.forEach((l) => l());
}
/** The subscribe/getVersion shape every store here has, so a component can
 *  `useStoreSync(pricing)` and redraw when the catalogue lands or refreshes. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getVersion(): number {
  return version;
}

function retireOldKeys(): void {
  if (retiredOnce) return;
  retiredOnce = true;
  try {
    for (const k of RETIRED_KEYS) localStorage.removeItem(k);
  } catch {
    /* storage blocked — nothing to free */
  }
}

interface Stored {
  shape: number;
  models: Record<string, ModelPrice>;
}

async function fetchCatalogue(): Promise<Record<string, ModelPrice> | null> {
  try {
    const res = await fetch(CATALOGUE);
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { data?: RawModel[] };
    const models: Record<string, ModelPrice> = {};
    for (const raw of j.data || []) {
      const rec = fromRaw(raw);
      if (rec) models[rec.id] = rec;
    }
    if (!Object.keys(models).length) throw new Error("empty catalogue");
    memo = models;
    fetchedAt = Date.now();
    failedAt = 0;
    notify();
    void writeCached<Stored>("models", { shape: SHAPE, models });
    return models;
  } catch {
    failedAt = Date.now();
    return null;
  }
}

function revalidate(): void {
  if (revalidating) return;
  revalidating = true;
  void fetchCatalogue().finally(() => {
    revalidating = false;
  });
}

/** Load the catalogue. Runs for every backend, not just OpenRouter — see the
 *  header. Resolves to an empty map when nothing could be had, which callers
 *  read as "not known", never as "there are no models". */
export function loadPricing(): Promise<Record<string, ModelPrice>> {
  retireOldKeys();
  if (memo) {
    if (Date.now() - fetchedAt > TTL && Date.now() - failedAt > RETRY_MS) revalidate();
    return Promise.resolve(memo);
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const cached = await readCached<Stored>("models");
    if (cached?.data?.shape === SHAPE && cached.data.models && Object.keys(cached.data.models).length) {
      memo = cached.data.models;
      fetchedAt = cached.at;
      notify();
      if (Date.now() - cached.at > TTL) revalidate();
      return memo;
    }
    if (Date.now() - failedAt < RETRY_MS) return {};
    return (await fetchCatalogue()) || {};
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Throw the cached copy away and fetch again — the picker's refresh button. */
export async function refreshCatalogue(): Promise<boolean> {
  failedAt = 0;
  return !!(await fetchCatalogue());
}

/** When the catalogue in memory was fetched; 0 when there is none yet. */
export function catalogueAt(): number {
  return memo ? fetchedAt : 0;
}

export function catalogueLoaded(): boolean {
  return !!memo;
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
    /* A router's "varies" is not a price anything can be multiplied by. */
    if (hit) return hit.variable ? undefined : hit;
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

/** Every model of one kind the catalogue knows, in no particular order. */
export function modelsOfKind(kind: ModelKind): ModelPrice[] {
  if (!memo) return [];
  return Object.values(memo).filter((m) => m.kinds?.includes(kind));
}

/* ---------------------------------------------------------------- speech -- */

export interface SpeechModel {
  id: string;
  name?: string;
  /** USD per character, when the model bills by the character. Undefined for
   *  one billed some other way — Gemini's speech models count audio tokens —
   *  which a character count cannot price, so it shows as unknown. */
  perChar?: number;
  /** The voices the model publishes. Empty means it publishes none. */
  voices: string[];
}

let speechMemo: Record<string, SpeechModel> | null = null;
let speechFrom: Record<string, ModelPrice> | null = null;

/** The speech models, derived from the one catalogue. Null while it has not
 *  loaded — which callers read as "not known yet", never as "there are no
 *  speech models". Recomputed only when the catalogue object changes. */
export function speechCatalogue(): Record<string, SpeechModel> | null {
  if (!memo) return null;
  if (speechMemo && speechFrom === memo) return speechMemo;
  const out: Record<string, SpeechModel> = {};
  for (const m of Object.values(memo)) {
    if (!m.kinds?.includes("speech")) continue;
    out[m.id] = { id: m.id, name: m.name, perChar: m.perChar, voices: m.voices || [] };
  }
  speechFrom = memo;
  speechMemo = Object.keys(out).length ? out : null;
  return speechMemo;
}

/** Kept as its own entry point for the callers that only care about voices;
 *  it is the same fetch as everything else now. */
export async function loadSpeechCatalogue(): Promise<Record<string, SpeechModel> | null> {
  await loadPricing();
  return speechCatalogue();
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
  return memo?.[model]?.perChar;
}

/** The transcription models the catalogue lists, cheapest first. Empty while
 *  it has not loaded — the caller keeps its own short list for that. */
export function transcriptionModels(): string[] {
  return modelsOfKind("transcription")
    .sort((a, b) => (a.perSecond ?? Infinity) - (b.perSecond ?? Infinity) || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

/* --------------------------------------------------------- image, video -- */

interface Listing<T> {
  memo: Record<string, T> | null;
  at: number;
  inflight: Promise<Record<string, T>> | null;
  failedAt: number;
}

function listing<T>(): Listing<T> {
  return { memo: null, at: 0, inflight: null, failedAt: 0 };
}

const images = listing<ImageCaps>();
const videos = listing<VideoCaps>();

async function loadListing<T>(
  l: Listing<T>,
  key: string,
  url: string,
  parse: (raw: unknown) => T | undefined,
  idOf: (t: T) => string
): Promise<Record<string, T>> {
  if (l.memo) return l.memo;
  if (l.inflight) return l.inflight;
  l.inflight = (async () => {
    const cached = await readCached<{ shape: number; items: Record<string, T> }>(key);
    const fresh = cached && Date.now() - cached.at <= TTL;
    if (cached?.data?.shape === SHAPE && fresh) {
      l.memo = cached.data.items;
      l.at = cached.at;
      return l.memo;
    }
    if (Date.now() - l.failedAt < RETRY_MS && cached?.data?.shape === SHAPE) {
      l.memo = cached.data.items;
      return l.memo;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { data?: unknown[] };
      const items: Record<string, T> = {};
      for (const raw of j.data || []) {
        const t = parse(raw);
        if (t) items[idOf(t)] = t;
      }
      l.memo = items;
      l.at = Date.now();
      notify();
      void writeCached(key, { shape: SHAPE, items });
      return items;
    } catch {
      l.failedAt = Date.now();
      /* Yesterday's listing beats none: which dials a model takes changes
         far more slowly than its price. */
      if (cached?.data?.shape === SHAPE) {
        l.memo = cached.data.items;
        return l.memo;
      }
      return {};
    }
  })().finally(() => {
    l.inflight = null;
  });
  return l.inflight;
}

/** Which dials each image model takes. Fetched the first time Image mode or
 *  an image picker needs it. */
export function loadImageCaps(): Promise<Record<string, ImageCaps>> {
  return loadListing(images, "images", API + "/images/models", parseImageCaps, (c) => c.id);
}

export function imageCaps(id: string): ImageCaps | undefined {
  return images.memo?.[id];
}

/** Durations, resolutions and prices for each video model. */
export async function loadVideoCaps(): Promise<Record<string, VideoCaps>> {
  /* The main catalogue says which inputs a model takes, which is how an
     edit-only model is told apart from one that makes a clip from words. */
  await loadPricing();
  return loadListing(videos, "videos", API + "/videos/models", (raw) => parseVideoCaps(raw, memo?.[(raw as { id?: string })?.id || ""]?.inputModalities), (c) => c.id);
}

export function videoCaps(id: string): VideoCaps | undefined {
  return videos.memo?.[id];
}

/** What one image costs through the Images API, from a model's endpoints.
 *  Fetched per model on demand — the listing itself carries no prices, and
 *  fifty-five requests to price a list nobody is reading would be rude. */
export interface ImageRate {
  usd: number;
  /** "image", "megapixel", … as the endpoint states it. */
  unit: string;
  variant?: string;
}

const imageRates = new Map<string, Promise<ImageRate[] | null>>();
const imageRatesDone = new Map<string, ImageRate[]>();

/** A picture's price if it has already been fetched — for a list row, which
 *  cannot fetch fifty-five of them to draw itself. */
export function imageRatesNow(id: string): ImageRate[] | undefined {
  return imageRatesDone.get(id);
}

export function loadImageRates(id: string): Promise<ImageRate[] | null> {
  const hit = imageRates.get(id);
  if (hit) return hit;
  const p = fetch(`${API}/images/models/${id}/endpoints`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { endpoints?: { pricing?: { billable?: string; unit?: string; cost_usd?: number; variant?: string }[] }[] }) => {
      const out: ImageRate[] = [];
      for (const ep of j.endpoints || []) {
        for (const pr of ep.pricing || []) {
          if (typeof pr.cost_usd !== "number" || pr.billable !== "output_image") continue;
          out.push({ usd: pr.cost_usd, unit: pr.unit || "image", variant: pr.variant || undefined });
        }
        if (out.length) break; // the first endpoint is the one a request lands on
      }
      if (out.length) {
        imageRatesDone.set(id, out);
        notify();
      }
      return out;
    })
    .catch(() => {
      imageRates.delete(id);
      return null;
    });
  imageRates.set(id, p);
  return p;
}

export function clearPricing(): void {
  memo = null;
  speechMemo = null;
  images.memo = null;
  videos.memo = null;
  imageRates.clear();
  fetchedAt = 0;
  void clearCached();
  retiredOnce = false;
  retireOldKeys();
  notify();
}
