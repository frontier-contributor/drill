/* ============================================================================
 * mediaCaps.ts — what an image or video model will actually accept.
 *
 * lib/imageSpec.ts was written when the only place to ask was `/models`, whose
 * `supported_parameters` lists no image control for any model — so the dials
 * could not be gated, and verified themselves after the fact instead. That is
 * still true of `/models`. But OpenRouter now publishes two listings made for
 * exactly this question:
 *
 *   /api/v1/images/models   per model, every dial as a typed descriptor —
 *                           {type:"enum", values}, {type:"range", min, max},
 *                           {type:"boolean"} — and absent means unsupported
 *   /api/v1/videos/models   durations, resolutions, aspect ratios, sizes,
 *                           first/last-frame support, audio, and price SKUs
 *
 * So a dial is now shown only when the model takes it, with only the values
 * it takes. A model the listing has never heard of keeps the old behaviour —
 * everything offered, the receipt checking afterwards — because unknown is
 * not no (the three-state rule lib/thinking.ts set).
 *
 * The video estimate is the other half. A clip is billed per second, in one
 * of half a dozen SKU spellings, and it is the most expensive thing this app
 * can do: eight seconds of Veo at 4K is $2.40. The composer says what a clip
 * will cost *before* it is asked for, which means reading every spelling —
 * and saying "priced after" for the one (video tokens) whose count nobody can
 * know in advance, rather than guessing. mediaCaps.test.ts holds the real
 * SKUs from the listing.
 *
 * Pure.
 * ========================================================================== */

type Descriptor = { type?: string; values?: unknown[]; min?: number; max?: number };

export interface Range {
  min: number;
  max: number;
}

export interface ImageCaps {
  id: string;
  name?: string;
  /** Output modalities from the listing. `text` here means the model also
   *  writes words — the Gemini image models — and is reached through chat,
   *  where it keeps the conversation; the rest go through /images. */
  talks: boolean;
  aspects?: string[];
  resolutions?: string[];
  quality?: string[];
  background?: string[];
  formats?: string[];
  /** How many reference pictures it takes; absent means none. */
  refs?: Range;
  /** How many pictures one request can return. */
  n?: Range;
  seed?: boolean;
  stream?: boolean;
}

function enumOf(d: Descriptor | undefined): string[] | undefined {
  if (!d || d.type !== "enum" || !Array.isArray(d.values)) return undefined;
  const vals = d.values.filter((v): v is string => typeof v === "string" && !!v);
  return vals.length ? vals : undefined;
}

function rangeOf(d: Descriptor | undefined): Range | undefined {
  if (!d || d.type !== "range" || typeof d.min !== "number" || typeof d.max !== "number") return undefined;
  return { min: d.min, max: d.max };
}

export function parseImageCaps(raw: unknown): ImageCaps | undefined {
  const m = raw as {
    id?: string;
    name?: string;
    architecture?: { output_modalities?: string[] };
    supported_parameters?: Record<string, Descriptor>;
    supports_streaming?: boolean;
  };
  if (!m?.id) return undefined;
  const sp = m.supported_parameters || {};
  const refs = rangeOf(sp.input_references);
  return {
    id: m.id,
    name: m.name,
    talks: !!m.architecture?.output_modalities?.includes("text"),
    aspects: enumOf(sp.aspect_ratio),
    resolutions: enumOf(sp.resolution),
    quality: enumOf(sp.quality),
    background: enumOf(sp.background),
    formats: enumOf(sp.output_format),
    refs: refs && refs.max > 0 ? refs : undefined,
    n: rangeOf(sp.n),
    seed: sp.seed?.type === "boolean" || undefined,
    stream: m.supports_streaming || undefined
  };
}

/* ----------------------------------------------------------------- video -- */

export interface VideoCaps {
  id: string;
  name?: string;
  durations?: number[];
  resolutions?: string[];
  aspects?: string[];
  sizes?: string[];
  /** "first_frame" and/or "last_frame": pictures it can start or end on. */
  frames?: string[];
  /** It can make a soundtrack, and `generate_audio` switches it. */
  audio?: boolean;
  seed?: boolean;
  /** Price SKUs as numbers, keyed as the listing keys them. */
  skus: Record<string, number>;
  /** Special-purpose models that edit or upscale a video you give them.
   *  There is no video to give them from a prompt box, so they are listed but
   *  cannot be chosen for a new clip. */
  needsVideo?: boolean;
}

export function parseVideoCaps(raw: unknown, inputs?: string[]): VideoCaps | undefined {
  const m = raw as {
    id?: string;
    name?: string;
    supported_durations?: unknown;
    supported_resolutions?: unknown;
    supported_aspect_ratios?: unknown;
    supported_sizes?: unknown;
    supported_frame_images?: unknown;
    generate_audio?: unknown;
    seed?: unknown;
    pricing_skus?: Record<string, unknown>;
  };
  if (!m?.id) return undefined;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const durations = Array.isArray(m.supported_durations)
    ? [...new Set(m.supported_durations.filter((x): x is number => typeof x === "number" && x > 0))].sort((a, b) => a - b)
    : undefined;
  const skus: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.pricing_skus || {})) {
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (Number.isFinite(n)) skus[k] = n;
  }
  const frames = strs(m.supported_frame_images);
  return {
    id: m.id,
    name: m.name,
    durations: durations?.length ? durations : undefined,
    resolutions: strs(m.supported_resolutions),
    aspects: strs(m.supported_aspect_ratios),
    sizes: strs(m.supported_sizes),
    frames: frames?.length ? frames : undefined,
    audio: m.generate_audio === true || undefined,
    seed: m.seed === true || undefined,
    skus,
    needsVideo: (!!inputs?.includes("video") && !durations?.length && !frames?.length) || undefined
  };
}

export interface VideoAsk {
  seconds: number;
  resolution?: string;
  audio?: boolean;
  /** Starting from a picture rather than from words alone. */
  fromImage?: boolean;
}

export interface VideoEstimate {
  /** Undefined when the model bills in a unit nobody can count in advance. */
  usd?: number;
  /** The rate it was worked out from, in words: "$0.10/s × 8s". */
  basis: string;
}

/**
 * What a clip will cost, from the SKUs the listing publishes.
 *
 * SKUs are tried from the most specific to the least — the audio variant at
 * this resolution, then the audio variant, then text-to-video or
 * image-to-video at this resolution, then the plain rate at this resolution,
 * then the plain rate. A key without a resolution suffix is the model's
 * default resolution, which is why it stands in when the chosen one has no
 * key of its own. Cents are converted; a per-generation minimum is applied;
 * a picture sent in is added when the model charges for it.
 */
export function videoEstimate(caps: VideoCaps | undefined, ask: VideoAsk): VideoEstimate {
  if (!caps) return { basis: "price not published" };
  const s = caps.skus;
  const res = (ask.resolution || "").toLowerCase();
  const mode = ask.fromImage ? "image_to_video" : "text_to_video";
  const withRes = (k: string) => (res ? [k + "_" + res, k] : [k]);

  const dollarKeys: string[] = [];
  if (ask.audio === true) dollarKeys.push(...withRes("duration_seconds_with_audio"));
  if (ask.audio === false) dollarKeys.push(...withRes("duration_seconds_without_audio"));
  if (res) dollarKeys.push(`${mode}_duration_seconds_${res}`);
  dollarKeys.push(...withRes("duration_seconds"));
  /* A model whose only rates are split by audio still has a price when the
     switch is left alone: the listing's default is with sound. */
  if (ask.audio == null) dollarKeys.push(...withRes("duration_seconds_with_audio"));

  let perSecond: number | undefined;
  for (const k of dollarKeys) {
    if (s[k] != null) {
      perSecond = s[k];
      break;
    }
  }
  if (perSecond == null) {
    for (const k of [...(res ? [`cents_per_video_output_second_${res}`, `cents_per_second_output_${res}`] : []), "cents_per_second_output"]) {
      if (s[k] != null) {
        perSecond = s[k] / 100;
        break;
      }
    }
  }

  if (perSecond == null) {
    if (Object.keys(s).some((k) => k.startsWith("video_tokens"))) return { basis: "billed per video token — the cost is shown once it is made" };
    if (Object.keys(s).some((k) => k.includes("megapixel"))) return { basis: "billed by the megapixel-second of the video you give it" };
    return { basis: "price not published" };
  }

  const seconds = Math.max(0, ask.seconds || 0);
  let usd = perSecond * seconds;
  if (ask.fromImage && s.cents_per_image_input != null) usd += s.cents_per_image_input / 100;
  if (s.minimum_cents_per_generation != null) usd = Math.max(usd, s.minimum_cents_per_generation / 100);
  const rate = perSecond >= 0.01 ? "$" + perSecond.toFixed(perSecond >= 0.1 ? 2 : 3).replace(/0$/, "") : "$" + perSecond.toPrecision(2);
  return { usd, basis: `${rate}/s × ${seconds}s` };
}

/** The per-second rate at the model's default settings, for a list row:
 *  "from $0.05/s". Undefined when there is no per-second rate. */
export function videoRate(caps: VideoCaps | undefined): number | undefined {
  if (!caps) return undefined;
  const rates: number[] = [];
  for (const [k, v] of Object.entries(caps.skus)) {
    if (/^(text_to_video_|image_to_video_)?duration_seconds/.test(k)) rates.push(v);
    else if (/^cents_per_(video_output_)?second/.test(k)) rates.push(v / 100);
  }
  return rates.length ? Math.min(...rates) : undefined;
}

/** "1280x720" → 16/9, for drawing a size as a shape. */
export function sizeRatio(size: string): number | undefined {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : undefined;
}

/** "16:9" → 16/9. */
export function aspectValue(a: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(a);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : undefined;
}
