/* ============================================================================
 * imageSpec.test.ts — the dial has to report, because it cannot be gated.
 *
 * Every other model-dependent control in this app is gated on OpenRouter's
 * `supported_parameters`. Image controls appear in that list for no image
 * model, so there is nothing to ask and the dials cannot be greyed out the
 * way Think's is. The only thing standing between them and CONTRIBUTING.md's
 * dead dial is `honoured()` — if it is wrong, the app either never reports an
 * ignored parameter, or cries wolf on every correct picture until the report
 * is worth nothing.
 *
 * The numbers below are the real sizes the Gemini image models return, which
 * is what makes this a calibration test rather than a restatement of the code.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IMAGE_SPEC, honoured, imageConfig, nearestAspect } from "@/lib/imageSpec";

/** id → the pixels a provider actually hands back for that request. */
const REAL: [Parameters<typeof honoured>[0], number, number][] = [
  ["1:1", 1024, 1024],
  ["3:2", 1248, 832],
  ["2:3", 832, 1248],
  ["4:3", 1184, 864],
  ["3:4", 864, 1184],
  ["16:9", 1344, 768],
  ["9:16", 768, 1344],
  ["21:9", 1536, 672]
];

test("every shape a provider really returns counts as honoured", () => {
  for (const [id, w, h] of REAL) {
    assert.equal(honoured(id, w, h), "ok", `${id} at ${w}x${h} should pass`);
  }
});

test("a square returned for a wide request is caught", () => {
  assert.equal(honoured("16:9", 1024, 1024), "ignored");
  assert.equal(honoured("21:9", 1024, 1024), "ignored");
  assert.equal(honoured("9:16", 1344, 768), "ignored");
});

test("nothing asked, nothing claimed", () => {
  assert.equal(honoured(undefined, 1024, 1024), "unknown");
  assert.equal(honoured("auto", 1024, 1024), "unknown");
  // A picture whose dimensions never got measured cannot be judged either.
  assert.equal(honoured("16:9", 0, 0), "unknown");
});

test("the delivered shape is named from the same table", () => {
  assert.equal(nearestAspect(1344, 768), "16:9");
  assert.equal(nearestAspect(1024, 1024), "1:1");
  assert.equal(nearestAspect(1184, 864), "4:3");
  // Nothing close enough to name is reported as the bare ratio, not as a lie.
  assert.equal(nearestAspect(1000, 137), "7.30:1");
});

test("the default sends nothing at all", () => {
  // The whole promise of Auto: a thread that never touched these dials makes
  // byte-identical requests to the ones it made before they existed.
  assert.equal(imageConfig(DEFAULT_IMAGE_SPEC), undefined);
  assert.equal(imageConfig(undefined), undefined);
  assert.deepEqual(imageConfig({ aspect: "16:9", size: "auto" }), { aspect_ratio: "16:9" });
  assert.deepEqual(imageConfig({ aspect: "auto", size: "2K" }), { image_size: "2K" });
  assert.deepEqual(imageConfig({ aspect: "1:1", size: "4K" }), { aspect_ratio: "1:1", image_size: "4K" });
});
