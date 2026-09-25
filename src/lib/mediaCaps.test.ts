/* ============================================================================
 * mediaCaps.test.ts — the price of a clip, said before it is bought.
 *
 * Video is the most expensive thing this app can ask for, and the composer
 * quotes it in advance. Every SKU below is copied from OpenRouter's
 * /api/v1/videos/models on 2026-09-25, one per spelling the listing uses, so
 * a change that reads one of them wrong fails here instead of on somebody's
 * bill. The token-billed models are held to saying so rather than guessing.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { parseImageCaps, parseVideoCaps, videoEstimate, videoRate } from "@/lib/mediaCaps";

const near = (a: number | undefined, b: number) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

const veoFast = parseVideoCaps({
  id: "google/veo-3.1-fast",
  supported_durations: [4, 6, 8],
  supported_resolutions: ["720p", "1080p", "4K"],
  generate_audio: true,
  supported_frame_images: ["first_frame", "last_frame"],
  pricing_skus: {
    duration_seconds_with_audio: "0.12",
    duration_seconds_with_audio_4k: "0.30",
    duration_seconds_without_audio: "0.10",
    duration_seconds_with_audio_720p: "0.10",
    duration_seconds_without_audio_4k: "0.25",
    duration_seconds_without_audio_720p: "0.08"
  }
})!;

test("audio and resolution pick the SKU, and the unsuffixed one is the default resolution", () => {
  near(videoEstimate(veoFast, { seconds: 8, resolution: "720p", audio: true }).usd, 0.8);
  near(videoEstimate(veoFast, { seconds: 8, resolution: "1080p", audio: true }).usd, 0.96);
  near(videoEstimate(veoFast, { seconds: 8, resolution: "4K", audio: true }).usd, 2.4);
  near(videoEstimate(veoFast, { seconds: 4, resolution: "720p", audio: false }).usd, 0.32);
  /* Sound left unsaid is sound on: generate_audio defaults to true for a
     model that can make it, so the quote must not be the silent price. */
  near(videoEstimate(veoFast, { seconds: 6, resolution: "1080p" }).usd, 0.72);
});

test("text-to-video and image-to-video are priced apart", () => {
  const wan = parseVideoCaps({
    id: "alibaba/wan-2.6",
    pricing_skus: {
      text_to_video_duration_seconds_720p: "0.08",
      image_to_video_duration_seconds_720p: "0.10",
      text_to_video_duration_seconds_1080p: "0.12"
    }
  })!;
  near(videoEstimate(wan, { seconds: 5, resolution: "720p" }).usd, 0.4);
  near(videoEstimate(wan, { seconds: 5, resolution: "720p", fromImage: true }).usd, 0.5);
});

test("an audio surcharge is charged when sound is on, and not when it is off", () => {
  const kling = parseVideoCaps({
    id: "kwaivgi/kling-v3.0-pro",
    pricing_skus: { duration_seconds: "0.112", duration_seconds_with_audio: "0.168", text_to_video_duration_seconds_720p: "0.112" }
  })!;
  near(videoEstimate(kling, { seconds: 10, resolution: "720p", audio: true }).usd, 1.68);
  near(videoEstimate(kling, { seconds: 10, resolution: "720p", audio: false }).usd, 1.12);
});

test("cents are dollars divided by a hundred, and a minimum is a minimum", () => {
  const grok = parseVideoCaps({
    id: "x-ai/grok-imagine-video",
    pricing_skus: { cents_per_image_input: "0.2", cents_per_video_output_second_480p: "5", cents_per_video_output_second_720p: "7" }
  })!;
  near(videoEstimate(grok, { seconds: 10, resolution: "720p" }).usd, 0.7);
  near(videoEstimate(grok, { seconds: 10, resolution: "720p", fromImage: true }).usd, 0.702);
  const aleph = parseVideoCaps({ id: "runway/aleph-2", pricing_skus: { cents_per_second_output: "28", minimum_cents_per_generation: "56" } })!;
  near(videoEstimate(aleph, { seconds: 1 }).usd, 0.56);
  near(videoEstimate(aleph, { seconds: 5 }).usd, 1.4);
  const flux = parseVideoCaps({ id: "black-forest-labs/flux-3-video", pricing_skus: { cents_per_second_output_720p: "17", cents_per_second_output_1080p: "29" } })!;
  near(videoEstimate(flux, { seconds: 5, resolution: "1080p" }).usd, 1.45);
});

test("a price counted in video tokens is not guessed", () => {
  const seedance = parseVideoCaps({ id: "bytedance/seedance-2.0", pricing_skus: { video_tokens: "0.000007", video_tokens_1080p: "0.0000077" } })!;
  const e = videoEstimate(seedance, { seconds: 5, resolution: "1080p" });
  assert.equal(e.usd, undefined);
  assert.match(e.basis, /video token/);
  assert.equal(videoRate(seedance), undefined);
});

test("a model that only edits a video it is given is marked, not offered as a generator", () => {
  assert.equal(parseVideoCaps({ id: "black-forest-labs/flux-video-edit", pricing_skus: {} }, ["text", "video"])!.needsVideo, true);
  assert.equal(veoFast.needsVideo, undefined);
  assert.equal(videoRate(veoFast), 0.08);
});

test("image dials come from typed descriptors, and absent means not supported", () => {
  const caps = parseImageCaps({
    id: "black-forest-labs/flux.2-pro",
    architecture: { output_modalities: ["image"] },
    supported_parameters: {
      aspect_ratio: { type: "enum", values: ["1:1", "16:9", "auto"] },
      n: { type: "range", min: 1, max: 1 },
      input_references: { type: "range", min: 0, max: 8 },
      seed: { type: "boolean" }
    }
  })!;
  assert.deepEqual(caps.aspects, ["1:1", "16:9", "auto"]);
  assert.equal(caps.resolutions, undefined);
  assert.deepEqual(caps.refs, { min: 0, max: 8 });
  assert.equal(caps.talks, false);
  const none = parseImageCaps({ id: "x/y", architecture: { output_modalities: ["image", "text"] }, supported_parameters: { input_references: { type: "range", min: 0, max: 0 } } })!;
  assert.equal(none.refs, undefined, "a range of zero references is no references");
  assert.equal(none.talks, true);
});
