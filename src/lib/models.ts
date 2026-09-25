/* ============================================================================
 * models.ts — what a model is, read from the catalogue record that says so.
 *
 * OpenRouter publishes one record per model, and until 2026-09-25 this app
 * only ever asked for the text ones. `/models` with no filter means
 * `output_modalities=text`: 460 models, with every image-only generator, every
 * video model, every voice and every transcriber left out. So the picker could
 * not show FLUX, Seedream or GPT-Image under "Draws", Video did not exist, and
 * the voice list was a separate, half-read fetch. The catalogue is now fetched
 * with `output_modalities=all`, and this file is how a raw record becomes the
 * one shape everything else reads.
 *
 * Three things here are decisions rather than parsing:
 *
 *  - **Kinds come from the modalities, never from the name.** A model is a
 *    chat model because it writes text, an image model because it returns
 *    images — and one model can be both (Gemini's image models are). Guessing
 *    from "-tts" or "whisper" in an id is how a list silently loses the model
 *    that does not follow the pattern.
 *  - **A price of -1 means "varies", not minus a dollar.** The router models
 *    publish -1 because they bill whatever they route to. Parsed naively that
 *    is a picker showing "$-1000000.00/M".
 *  - **`pricing.image` is what an image costs to *send*; `image_output` is
 *    what a drawn one costs, per output token.** The old catalogue read the
 *    first as the price of a generated picture.
 *
 * Also the search: tokens are matched against id, name and vendor with the
 * punctuation taken out of both sides, so "sonnet 4.5", "sonnet45" and
 * "claude-sonnet-4.5" all find the same model — people type model names the
 * way they remember them, not the way the catalogue spells them.
 *
 * Pure. No stores, no DOM, no network — models.test.ts walks all of it.
 * ========================================================================== */
import type { ModelKind, ModelPrice } from "@/types/chat";

export type { ModelKind };

/** The fields of an OpenRouter `/models` record this app reads. */
export interface RawModel {
  id?: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number;
  pricing?: Record<string, unknown>;
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number | null; is_moderated?: boolean };
  supported_voices?: unknown;
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
}

/** Output modality → kind. "audio" is a chat model that can also speak; it
 *  still writes text, which is what makes it a chat model here. */
export function kindsOf(output: readonly string[] | undefined): ModelKind[] {
  const out = new Set<ModelKind>();
  for (const m of output || []) {
    if (m === "text") out.add("chat");
    else if (m === "image") out.add("image");
    else if (m === "video") out.add("video");
    else if (m === "speech") out.add("speech");
    else if (m === "transcription") out.add("transcription");
    else if (m === "embeddings") out.add("embedding");
  }
  if (!out.size && (output || []).length) out.add("other");
  return [...out];
}

/** USD per token as a decimal string → a number, or undefined for anything
 *  absent or unparseable. Negative is kept: it is the router's "varies". */
function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

/** A description trimmed to what a detail card can hold: whole sentences up
 *  to about 280 characters, so it never stops mid-word, and never more than
 *  three — the fourth sentence of a model card is always marketing. */
export function trimAbout(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  /* Descriptions are markdown. Links keep their words; backticks and bold
     markers go, since the card is prose and "`reasoning.mode`" reads as a
     typo there. Underscores stay — they are inside voice and model ids. */
  const clean = text
    .replace(/\s+/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .trim();
  if (!clean) return undefined;
  /* Split only where punctuation is followed by a space. Splitting on the
     punctuation itself cut "Claude Sonnet 4.5 is…" at the version number and
     dropped the model's own name off the front of its description. */
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences.slice(0, 3)) {
    if ((out + " " + s).length > max && out) break;
    out = out ? out + " " + s : s;
  }
  out = out.trim();
  if (out.length > max) out = out.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return out || undefined;
}

/** "Anthropic: Claude Sonnet 4.5" → vendor "Anthropic", title "Claude Sonnet
 *  4.5". A name with no colon keeps its whole self as the title and takes the
 *  vendor from the id. */
export function splitName(id: string, name?: string): { vendor: string; title: string } {
  const slug = vendorSlug(id);
  if (name) {
    const i = name.indexOf(": ");
    if (i > 0) return { vendor: name.slice(0, i).trim(), title: name.slice(i + 2).trim() || name };
    return { vendor: prettySlug(slug), title: name.trim() };
  }
  return { vendor: prettySlug(slug), title: tailOf(id) };
}

/** "anthropic/claude-sonnet-4.5" → "anthropic". A bare id — a local model, a
 *  custom server's — belongs to "local". OpenRouter's "latest pointer" ids
 *  carry a leading `~`, which is stripped so they file with the vendor. */
export function vendorSlug(id: string): string {
  const i = id.indexOf("/");
  return (i > 0 ? id.slice(0, i) : "local").replace(/^~/, "");
}

export function tailOf(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(i + 1) : id;
}

function prettySlug(slug: string): string {
  if (slug === "local") return "Local";
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * One raw record → the app's model record. Undefined for a record with no id.
 *
 * Prices are stored per million tokens, as they always have been here, so a
 * legible number sits in memory and nobody multiplies by a million twice.
 * Per-character (speech) and per-second (transcription) rates are kept in
 * their own units, because that is how those models bill.
 */
export function fromRaw(m: RawModel): ModelPrice | undefined {
  if (!m.id) return undefined;
  const p = m.pricing || {};
  const promptRaw = num(p.prompt);
  const completionRaw = num(p.completion);
  const variable = (promptRaw ?? 0) < 0 || (completionRaw ?? 0) < 0;
  const output = m.architecture?.output_modalities;
  const kinds = kindsOf(output);
  const params = m.supported_parameters || [];
  const voices = Array.isArray(m.supported_voices)
    ? (m.supported_voices as unknown[]).filter((v): v is string => typeof v === "string" && !!v)
    : undefined;
  const { vendor, title } = splitName(m.id, m.name);

  const rec: ModelPrice = {
    id: m.id,
    name: m.name,
    vendor,
    title,
    about: trimAbout(m.description),
    created: m.created ? m.created * 1000 : undefined,
    kinds,
    prompt: variable ? 0 : (promptRaw ?? 0) * 1e6,
    completion: variable ? 0 : (completionRaw ?? 0) * 1e6,
    variable: variable || undefined,
    contextLength: m.context_length || undefined,
    /* "reasoning" is the parameter you send to make a model think;
       "include_reasoning" only asks for the trace back. A model that
       advertises either one accepts the switch. */
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    inputModalities: m.architecture?.input_modalities,
    outputModalities: output,
    maxOutput: m.top_provider?.max_completion_tokens || undefined,
    cutoff: m.knowledge_cutoff || undefined,
    expires: m.expiration_date || undefined
  };

  const imageIn = num(p.image);
  if (imageIn != null && imageIn > 0) rec.imageInput = imageIn;
  const imageOut = num(p.image_output);
  if (imageOut != null && imageOut > 0) rec.imageOutput = imageOut * 1e6;
  const search = num(p.web_search);
  if (search != null && search > 0) rec.webSearch = search;

  /* Above a prompt size, some models charge more — Claude and Gemini both
     double past 200k tokens. Worth saying on the card, because it is the
     surprise on the bill of anyone who attaches a long PDF. */
  const over = Array.isArray(p.overrides) ? (p.overrides as Record<string, unknown>[])[0] : undefined;
  if (over && typeof over.min_prompt_tokens === "number") {
    const op = num(over.prompt);
    const oc = num(over.completion);
    if (op != null && oc != null) rec.tiered = { above: over.min_prompt_tokens, prompt: op * 1e6, completion: oc * 1e6 };
  }

  if (kinds.includes("speech")) {
    rec.voices = voices || [];
    /* Speech bills per character of input, carried in `prompt` with
       `completion` at zero. A model with a completion rate bills by the audio
       it makes (Gemini's voices count audio tokens), which no character count
       prices honestly — so that rate is left unknown, not guessed. */
    if (promptRaw != null && promptRaw >= 0 && (completionRaw == null || completionRaw === 0)) rec.perChar = promptRaw;
  }
  if (kinds.includes("transcription") && promptRaw != null && promptRaw >= 0 && (completionRaw == null || completionRaw === 0)) {
    /* Transcription is billed per second of audio, in `prompt`. */
    rec.perSecond = promptRaw;
  }
  return rec;
}

/* ---------------------------------------------------------------- facts -- */

export function isFree(m: ModelPrice | undefined): boolean {
  if (!m || m.variable) return false;
  if (m.kinds?.includes("speech") && !m.kinds.includes("chat")) return m.perChar === 0;
  return m.prompt === 0 && m.completion === 0 && !m.imageOutput;
}

/** Released in the last six weeks. The catalogue adds several models a week,
 *  and "new" is what makes the one you read about yesterday findable. */
export const NEW_FOR_MS = 42 * 24 * 60 * 60 * 1000;

export function isNew(m: ModelPrice | undefined, now = Date.now()): boolean {
  return !!m?.created && now - m.created < NEW_FOR_MS && m.created <= now + 24 * 3600 * 1000;
}

export function canSee(m: ModelPrice | undefined): boolean {
  return !!m?.inputModalities?.includes("image");
}

export function readsFiles(m: ModelPrice | undefined): boolean {
  return !!m?.inputModalities?.includes("file");
}

export function hears(m: ModelPrice | undefined): boolean {
  return !!m?.inputModalities?.includes("audio");
}

export function draws(m: ModelPrice | undefined): boolean {
  return !!m?.outputModalities?.includes("image");
}

/* ------------------------------------------------------------- format -- */

/** $3 → "$3", $0.15 → "$0.15", $0.0375 → "$0.038". Enough precision to tell
 *  two cheap models apart, never a trailing ".00" on a whole number. */
export function money(usd: number): string {
  if (usd === 0) return "$0";
  if (usd >= 100) return "$" + Math.round(usd).toLocaleString();
  if (usd >= 1) return "$" + (Math.round(usd * 100) / 100).toString();
  if (usd >= 0.01) return "$" + usd.toFixed(2).replace(/0$/, "");
  /* Two significant figures, and no trailing zero: toPrecision keeps one
     ("0.0040"), and a price is read, not measured. toFixed rather than the
     number's own toString, which switches to "1e-7" below a millionth. */
  const sig = Number(usd.toPrecision(2));
  const places = Math.min(12, Math.max(2, 1 - Math.floor(Math.log10(sig))));
  return "$" + sig.toFixed(places).replace(/0+$/, "").replace(/\.$/, "");
}

export function tokens(n: number | undefined): string {
  if (!n) return "";
  if (n >= 1_000_000) return (Math.round(n / 100_000) / 10).toString().replace(/\.0$/, "") + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

/** The price a row has room for, by kind: tokens in and out for a chat
 *  model, characters for a voice, minutes for a transcriber. */
export function priceLine(m: ModelPrice | undefined, kind: ModelKind): string {
  if (!m) return "";
  if (m.variable) return "varies";
  if (kind === "speech") {
    if (m.perChar === 0) return "free";
    return m.perChar != null ? money(m.perChar * 1000) + "/1k chars" : "by audio length";
  }
  if (kind === "transcription") {
    if (m.perSecond === 0) return "free";
    return m.perSecond != null ? money(m.perSecond * 60) + "/min" : "";
  }
  if (kind === "image") {
    if (isFree(m)) return "free";
    return m.imageOutput ? money(m.imageOutput) + "/M img tok" : "";
  }
  if (kind === "video") return "";
  if (isFree(m)) return "free";
  return money(m.prompt) + " / " + money(m.completion);
}

/* ------------------------------------------------------------- search -- */

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Every query token must appear, punctuation ignored on both sides. */
export function matches(m: Pick<ModelPrice, "id" | "name" | "vendor" | "title">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = squash([m.id, m.name || "", m.vendor || "", m.title || ""].join(" "));
  return q
    .split(/\s+/)
    .map(squash)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

/**
 * How well a model answers a query, for ordering search results: an exact id
 * first, then a title that starts with what was typed, then a match at a word
 * start, then anywhere. Ties go to the newer model, because the one you
 * searched for is usually the one that just came out.
 */
export function relevance(m: Pick<ModelPrice, "id" | "title" | "name">, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const id = m.id.toLowerCase();
  const title = (m.title || m.name || m.id).toLowerCase();
  if (id === q || tailOf(id) === q) return 100;
  if (squash(title).startsWith(squash(q))) return 80;
  if (squash(tailOf(id)).startsWith(squash(q))) return 70;
  const words = title.split(/[\s\-_/.:]+/);
  const first = q.split(/\s+/)[0];
  if (words.some((w) => w.startsWith(first))) return 50;
  return 10;
}

export type SortId = "provider" | "newest" | "cheapest" | "context" | "name";

/** The number a sort by price compares: what a typical reply costs, which is
 *  mostly output. Unknown and variable prices sort last, not first — a model
 *  with no published price is not the cheapest one. */
export function sortPrice(m: ModelPrice | undefined, kind: ModelKind): number {
  if (!m || m.variable) return Infinity;
  if (kind === "speech") return m.perChar ?? Infinity;
  if (kind === "transcription") return m.perSecond ?? Infinity;
  if (kind === "image") return m.imageOutput ?? (isFree(m) ? 0 : Infinity);
  return m.prompt + 3 * m.completion;
}

/**
 * Provider groups, largest first — derived, so there is no hand-kept list of
 * "the important vendors" to go stale. Size is the proxy: the providers people
 * go looking for are the ones with a catalogue's worth of models, and ordering
 * by latest release instead put a one-model vendor that shipped last week at
 * the top of every picker. Within a group, newest first.
 */
export function groupByVendor(ids: string[], entry: (id: string) => ModelPrice | undefined): { slug: string; label: string; ids: string[] }[] {
  const by = new Map<string, { label: string; ids: string[]; newest: number }>();
  for (const id of ids) {
    const e = entry(id);
    const slug = vendorSlug(id);
    const g = by.get(slug) || { label: e?.vendor || splitName(id).vendor, ids: [], newest: 0 };
    g.ids.push(id);
    g.newest = Math.max(g.newest, e?.created || 0);
    if (e?.vendor && g.label !== e.vendor && g.ids.length === 1) g.label = e.vendor;
    by.set(slug, g);
  }
  return [...by.entries()]
    .sort((a, b) => b[1].ids.length - a[1].ids.length || b[1].newest - a[1].newest || a[0].localeCompare(b[0]))
    .map(([slug, g]) => ({
      slug,
      label: g.label,
      ids: g.ids.sort((x, y) => (entry(y)?.created || 0) - (entry(x)?.created || 0) || x.localeCompare(y))
    }));
}
