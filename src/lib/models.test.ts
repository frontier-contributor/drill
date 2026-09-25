/* ============================================================================
 * models.test.ts — a model is what its record says it is.
 *
 * The failure this guards is the one that shipped: a picker that simply does
 * not show a model, with nothing anywhere to say one is missing. It happened
 * because the catalogue was only ever asked for text models; it would happen
 * again the moment kinds were read from ids ("-tts", "whisper") or a router's
 * "-1" was taken for a price. The records below are copied from OpenRouter's
 * /models?output_modalities=all on 2026-09-25.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { fromRaw, groupByVendor, isFree, kindsOf, matches, money, priceLine, relevance, splitName, trimAbout } from "@/lib/models";
import type { ModelPrice } from "@/types/chat";

test("kinds come from what a model outputs, and one model can be two kinds", () => {
  assert.deepEqual(kindsOf(["text"]), ["chat"]);
  assert.deepEqual(kindsOf(["image", "text"]).sort(), ["chat", "image"]);
  assert.deepEqual(kindsOf(["image"]), ["image"]);
  assert.deepEqual(kindsOf(["video"]), ["video"]);
  assert.deepEqual(kindsOf(["speech"]), ["speech"]);
  assert.deepEqual(kindsOf(["transcription"]), ["transcription"]);
  assert.deepEqual(kindsOf(["text", "audio"]), ["chat"], "a chat model that can also speak is still a chat model");
  assert.deepEqual(kindsOf(["rerank"]), ["other"]);
});

test("an image-only generator is an image model with its output price, not its input price", () => {
  const flux = fromRaw({
    id: "black-forest-labs/flux.2-pro",
    name: "Black Forest Labs: FLUX.2 [pro]",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
    pricing: { prompt: "0", completion: "0", image_output: "0.00000732421875" }
  })!;
  assert.deepEqual(flux.kinds, ["image"]);
  assert.equal(flux.vendor, "Black Forest Labs");
  assert.equal(flux.title, "FLUX.2 [pro]");
  assert.ok(Math.abs(flux.imageOutput! - 7.32421875) < 1e-9);
  assert.equal(isFree(flux), false, "zero token prices are not free when drawing is billed");

  const gemini = fromRaw({
    id: "google/gemini-2.5-flash-image",
    architecture: { output_modalities: ["image", "text"] },
    pricing: { prompt: "0.0000003", completion: "0.0000025", image: "0.0000003", image_output: "0.00003" }
  })!;
  assert.equal(gemini.imageInput, 0.0000003, "pricing.image is what a picture costs to send");
  assert.equal(gemini.imageOutput, 30);
});

test("a router's -1 is 'varies', never a negative price", () => {
  const auto = fromRaw({ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" }, architecture: { output_modalities: ["text"] } })!;
  assert.equal(auto.variable, true);
  assert.equal(auto.prompt, 0);
  assert.equal(priceLine(auto, "chat"), "varies");
  assert.equal(isFree(auto), false);
});

test("a voice is priced per character only when it bills that way", () => {
  const kokoro = fromRaw({
    id: "hexgrad/kokoro-82m",
    architecture: { output_modalities: ["speech"] },
    pricing: { prompt: "0.000004", completion: "0" },
    supported_voices: ["af_heart", "am_adam"]
  })!;
  assert.equal(kokoro.perChar, 0.000004);
  assert.deepEqual(kokoro.voices, ["af_heart", "am_adam"]);
  assert.equal(priceLine(kokoro, "speech"), "$0.004/1k chars");
  const gemTts = fromRaw({
    id: "google/gemini-3.8-flash-tts",
    architecture: { output_modalities: ["speech"] },
    pricing: { prompt: "0.0000005", completion: "0.000009" },
    supported_voices: ["Kore"]
  })!;
  assert.equal(gemTts.perChar, undefined, "billed by audio tokens: not a per-character rate");
  assert.equal(priceLine(gemTts, "speech"), "by audio length");
  const fish = fromRaw({ id: "fish-audio/s1", architecture: { output_modalities: ["speech"] }, pricing: { prompt: "0.000015", completion: "0" } })!;
  assert.deepEqual(fish.voices, [], "publishes none — not unknown, none");
});

test("a transcriber is priced by the minute", () => {
  const w = fromRaw({ id: "openai/whisper-large-v3-turbo", architecture: { output_modalities: ["transcription"] }, pricing: { prompt: "0.00000333", completion: "0" } })!;
  assert.deepEqual(w.kinds, ["transcription"]);
  assert.equal(priceLine(w, "transcription"), "$0.0002/min");
});

test("a doubling above a prompt size is kept", () => {
  const c = fromRaw({
    id: "anthropic/claude-sonnet-4.5",
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015", overrides: [{ min_prompt_tokens: 200000, prompt: "0.000006", completion: "0.0000225" }] }
  })!;
  assert.deepEqual(c.tiered, { above: 200000, prompt: 6, completion: 22.5 });
  assert.equal(priceLine(c, "chat"), "$3 / $15");
});

test("names split into vendor and title, and fall back to the id", () => {
  assert.deepEqual(splitName("anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5"), { vendor: "Anthropic", title: "Claude Sonnet 4.5" });
  assert.deepEqual(splitName("meta-llama/llama-3.3-70b-instruct"), { vendor: "Meta Llama", title: "llama-3.3-70b-instruct" });
  assert.deepEqual(splitName("qwen2.5:7b"), { vendor: "Local", title: "qwen2.5:7b" });
});

test("search ignores punctuation, needs every word, and ranks the obvious hit first", () => {
  const m = { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", vendor: "Anthropic", title: "Claude Sonnet 4.5" };
  assert.ok(matches(m, "sonnet 4.5"));
  assert.ok(matches(m, "sonnet45"));
  assert.ok(matches(m, "Claude-Sonnet"));
  assert.ok(!matches(m, "sonnet opus"));
  const exact = relevance(m, "claude-sonnet-4.5");
  const prefix = relevance(m, "claude son");
  const inside = relevance(m, "net");
  assert.ok(exact > prefix && prefix > inside);
});

test("providers are ordered by size, then by latest release, models newest first", () => {
  const entries: Record<string, ModelPrice> = {
    "a/old": { id: "a/old", prompt: 0, completion: 0, created: 1, vendor: "A" },
    "a/new": { id: "a/new", prompt: 0, completion: 0, created: 5, vendor: "A" },
    "b/mid": { id: "b/mid", prompt: 0, completion: 0, created: 9, vendor: "B" },
    "c/one": { id: "c/one", prompt: 0, completion: 0, created: 7, vendor: "C" }
  };
  const groups = groupByVendor(Object.keys(entries), (id) => entries[id]);
  assert.deepEqual(groups.map((g) => g.slug), ["a", "b", "c"], "the one-model vendor that shipped last is not first");
  assert.deepEqual(groups[0].ids, ["a/new", "a/old"]);
});

test("descriptions stop at a sentence, and money never says $-1", () => {
  assert.equal(trimAbout("One. Two. Three. Four is marketing."), "One. Two. Three.");
  assert.equal(
    trimAbout("Claude Sonnet 4.5 is Anthropic's best. It codes."),
    "Claude Sonnet 4.5 is Anthropic's best. It codes.",
    "a version number is not the end of a sentence"
  );
  assert.ok(trimAbout("x ".repeat(400))!.length <= 280);
  assert.equal(money(3), "$3");
  assert.equal(money(0.15), "$0.15");
  assert.equal(money(0.0375), "$0.04");
  assert.equal(money(0.0002), "$0.0002");
});
