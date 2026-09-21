/* ============================================================================
 * imageSpec.ts — what shape and size a generated picture was asked to be.
 *
 * Two dials, and both are honest about a problem this app cannot solve from
 * the catalogue. Every other model-dependent control here is gated on
 * OpenRouter's `supported_parameters` — that is how lib/thinking.ts knows
 * whether a model can reason. Image controls are not in that list for *any*
 * image-output model, so there is nothing to ask. Sending them is safe (an
 * unknown key is passed through and dropped by a provider that has no use for
 * it) but silently ignorable, which is exactly the dead dial CONTRIBUTING.md
 * forbids.
 *
 * So the dial verifies itself instead of being gated. The delivered picture's
 * pixels are already recorded on GeneratedImage, so "you asked for 16:9 and
 * this model gave you 1:1" is checkable after the fact, and the receipt under
 * the picture says it. A control that reports whether it worked is worth
 * having even when support cannot be known in advance; a control that cannot
 * report is not.
 *
 * Only the aspect is checked. A tier like "2K" is not a pixel count — 16:9 at
 * 1K comes back 1344×768 from one provider and 1024×576 from another — so
 * claiming it was ignored would be this file guessing. The delivered
 * dimensions are printed regardless, which is the honest version.
 *
 * The wire shape is the chat-completions one, `image_config: {aspect_ratio,
 * image_size}`, because that is the endpoint this app speaks: pictures arrive
 * on `choices[0].message.images[].image_url.url`, which is exactly what
 * readImages() in backends.ts already reads. OpenRouter's dedicated
 * /api/v1/images endpoint spells the same two dials `aspect_ratio` and
 * `resolution` and returns `data[].b64_json`; using it would mean a second
 * adapter, a second response shape and no streaming, for the same two values.
 * ========================================================================== */

/** "auto" is first and is the default: it means *do not send the parameter*,
 *  which is the only value guaranteed to behave exactly as this app did
 *  before these dials existed. */
export type AspectId = "auto" | "1:1" | "3:2" | "2:3" | "4:3" | "3:4" | "16:9" | "9:16" | "21:9";
export type SizeId = "auto" | "1K" | "2K" | "4K";

export interface ImageSpec {
  aspect: AspectId;
  size: SizeId;
}

export const DEFAULT_IMAGE_SPEC: ImageSpec = { aspect: "auto", size: "auto" };

/** The row in the composer. Labelled in words rather than in ratios alone —
 *  "16:9" is a number to anyone who has not spent time in a photo tool, and
 *  "Wide" is what the person actually wants. */
export const ASPECTS: { id: AspectId; label: string; ratio: number | null }[] = [
  { id: "auto", label: "Auto", ratio: null },
  { id: "1:1", label: "Square", ratio: 1 },
  { id: "3:2", label: "Photo", ratio: 3 / 2 },
  { id: "2:3", label: "Photo tall", ratio: 2 / 3 },
  { id: "4:3", label: "Classic", ratio: 4 / 3 },
  { id: "3:4", label: "Classic tall", ratio: 3 / 4 },
  { id: "16:9", label: "Wide", ratio: 16 / 9 },
  { id: "9:16", label: "Tall", ratio: 9 / 16 },
  { id: "21:9", label: "Ultrawide", ratio: 21 / 9 }
];

/* Upstream also takes 4:5, 5:4, 1:2, 2:1, 1:4, 4:1, 1:8, 8:1 and 9:21. They
   are left off deliberately: this is a row of buttons on the composer, not a
   settings page, and nine is already the most a glance can take. The ones
   kept are the ones a person names — square, photo, classic, wide, tall —
   in both orientations. Adding one means deciding what comes off. */

export const SIZES: { id: SizeId; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Whatever the model does by default." },
  { id: "1K", label: "1K", hint: "About a megapixel. Quick and cheap." },
  { id: "2K", label: "2K", hint: "Detail worth zooming into." },
  { id: "4K", label: "4K", hint: "Slow, and the dearest of the three." }
];

export function aspectRatio(id: AspectId): number | null {
  return ASPECTS.find((a) => a.id === id)?.ratio ?? null;
}

/**
 * The wire form, or undefined when there is nothing to say.
 *
 * `auto` on both dials sends no `image_config` at all rather than sending
 * `{"aspect_ratio":"auto"}`: the default has to be byte-for-byte the request
 * this app made before the dials existed, or adding a control would change
 * the output of every thread that never touched it.
 */
export function imageConfig(spec: ImageSpec | undefined): Record<string, string> | undefined {
  if (!spec) return undefined;
  const cfg: Record<string, string> = {};
  if (spec.aspect !== "auto") cfg.aspect_ratio = spec.aspect;
  if (spec.size !== "auto") cfg.image_size = spec.size;
  return Object.keys(cfg).length ? cfg : undefined;
}

export type Honoured = "ok" | "ignored" | "unknown";

/**
 * Did the picture come back the shape it was asked to be?
 *
 * The tolerance is 4%, and it is measured rather than guessed. A provider does
 * not return the exact ratio; it returns the nearest size on its own grid, and
 * these are the real ones for the Gemini image models this reaches:
 *
 *     1:1  → 1024×1024  (0.0% off)     4:3  → 1184×864   (2.8% off)
 *     3:2  → 1248×832   (0.0% off)     3:4  → 864×1184   (2.7% off)
 *     2:3  → 832×1248   (0.0% off)     16:9 → 1344×768   (1.6% off)
 *     9:16 → 768×1344   (1.6% off)     21:9 → 1536×672   (2.0% off)
 *
 * So 4% clears every honoured request with room to spare, while a square
 * returned for a wide one (44% off) is caught. Anything tighter would report
 * a correct 4:3 as ignored, which is the failure that matters — a checker
 * that cries wolf gets ignored itself.
 */
export function honoured(asked: AspectId | undefined, w: number, h: number): Honoured {
  const want = asked ? aspectRatio(asked) : null;
  if (want == null || !w || !h) return "unknown";
  const got = w / h;
  return Math.abs(got - want) / want <= 0.04 ? "ok" : "ignored";
}

/** The delivered shape, named. Lets the receipt say what you *did* get rather
 *  than only that it was not what you asked for. */
export function nearestAspect(w: number, h: number): string {
  if (!w || !h) return "";
  const got = w / h;
  let best = "";
  let bestOff = Infinity;
  for (const a of ASPECTS) {
    if (a.ratio == null) continue;
    const off = Math.abs(got - a.ratio) / a.ratio;
    if (off < bestOff) {
      bestOff = off;
      best = a.id;
    }
  }
  return bestOff <= 0.04 ? best : `${got.toFixed(2)}:1`;
}
