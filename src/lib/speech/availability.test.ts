/* ============================================================================
 * availability.test.ts — only offer what can actually speak.
 *
 * Two failures are being held off here, and they pull in opposite
 * directions. A Listen button that shows for a voice with no key behind it
 * fails every time it is pressed. A button greyed out because a list has not
 * loaded yet is the dead dial again, only with a better excuse. So: a no only
 * from a loaded list, a fallback that says why, and an unknown that stays
 * usable.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseEngine,
  deviceVerdict,
  hostedVerdict,
  pickVoice,
  rankDeviceVoices,
  type HostedFacts,
  type SpeechVerdict
} from "@/lib/speech/availability";

const YES: SpeechVerdict = { can: true, certain: true, why: "ok" };
const NO: SpeechVerdict = { can: false, certain: true, why: "Add your OpenRouter key under Settings → Connection." };

function hosted(over: Partial<HostedFacts> = {}): HostedFacts {
  return {
    label: "OpenRouter",
    speaks: true,
    needsKey: true,
    hasKey: true,
    source: "catalogue",
    model: "hexgrad/kokoro-82m",
    voices: ["af_heart", "am_adam"],
    ...over
  };
}

test("this device's voice: missing, loading, empty, present", () => {
  assert.equal(deviceVerdict({ supported: false, voices: null }).can, false);
  const loading = deviceVerdict({ supported: true, voices: null });
  assert.equal(loading.can, true, "voices still loading must not grey the button out");
  assert.equal(loading.certain, false);
  const none = deviceVerdict({ supported: true, voices: 0 });
  assert.equal(none.can, false);
  assert.match(none.why, /no voices/i);
  assert.deepEqual(deviceVerdict({ supported: true, voices: 12 }).can, true);
});

test("a hosted voice needs a key, and says where to put it", () => {
  const v = hostedVerdict(hosted({ hasKey: false }));
  assert.equal(v.can, false);
  assert.match(v.why, /Connection/);
});

test("a backend without a speech endpoint is refused before anything else is asked", () => {
  const v = hostedVerdict(hosted({ speaks: false, label: "Ollama", hasKey: false }));
  assert.equal(v.can, false);
  assert.match(v.why, /cannot read aloud/);
});

test("a catalogue that has not loaded leaves the voice usable", () => {
  const v = hostedVerdict(hosted({ voices: null }));
  assert.equal(v.can, true);
  assert.equal(v.certain, false);
});

test("a loaded catalogue that no longer lists the model says no, by name", () => {
  const v = hostedVerdict(hosted({ model: "vendor/retired-tts", voices: undefined }));
  assert.equal(v.can, false);
  assert.match(v.why, /retired-tts/);
  assert.doesNotMatch(v.why, /vendor\//);
});

test("a model that publishes no voice list is a hedge, not a refusal", () => {
  /* Fish Audio's voices are ids from its own library, not a list in the
     catalogue. Refusing them hid four working models; the request says
     plainly if a voice is wrong. */
  const v = hostedVerdict(hosted({ voices: [] }));
  assert.equal(v.can, true);
  assert.equal(v.certain, false);
  assert.match(v.why, /default voice/);
});

test("a server that cannot be asked in advance is a hedge, not a refusal", () => {
  const v = hostedVerdict(hosted({ source: "typed", needsKey: false, hasKey: false, voices: undefined }));
  assert.equal(v.can, true);
  assert.equal(v.certain, false);
});

test("the voice follows the model", () => {
  const voices = ["af_heart", "am_adam"];
  assert.equal(pickVoice(voices, "am_adam", "af_heart"), "am_adam");
  /* A voice from the previous model is swapped for the default, never sent. */
  assert.equal(pickVoice(voices, "eve", "af_heart"), "af_heart");
  assert.equal(pickVoice(voices, "eve", "nobody"), "af_heart");
  assert.equal(pickVoice([], "eve", "nobody"), "eve");
});

test("automatic prefers OpenRouter's voice, then this device's", () => {
  const all = { device: YES, openrouter: YES, groq: YES, custom: YES };
  assert.deepEqual(chooseEngine("", all), { engine: "openrouter", fellBack: null });
  assert.deepEqual(chooseEngine("", { ...all, openrouter: NO }), { engine: "device", fellBack: null });
  /* Groq's free tier and an unknown server are never chosen for you. */
  assert.equal(chooseEngine("", { ...all, openrouter: NO, device: NO }).engine, null);
});

test("a chosen engine that stops working falls back and says why", () => {
  const all = { device: YES, openrouter: NO, groq: YES, custom: YES };
  const c = chooseEngine("openrouter", all);
  assert.equal(c.engine, "device");
  assert.match(c.fellBack || "", /Connection/);
  assert.deepEqual(chooseEngine("groq", all), { engine: "groq", fellBack: null });
  assert.equal(chooseEngine("openrouter", { ...all, device: NO }).engine, null);
});

test("browser voices: the reader's language and English, network voices first", () => {
  const v = (name: string, lang: string, localService: boolean, isDefault = false) => ({
    voiceURI: name,
    name,
    lang,
    localService,
    default: isDefault
  });
  const ranked = rankDeviceVoices(
    [
      v("Microsoft David", "en-US", true, true),
      v("Anna", "de-DE", true),
      v("Microsoft Aria Online (Natural)", "en-US", false),
      v("Google हिन्दी", "hi-IN", false),
      v("Samantha", "en_GB", true)
    ],
    "hi-IN"
  ).map((x) => x.name);
  assert.deepEqual(ranked, ["Google हिन्दी", "Microsoft Aria Online (Natural)", "Microsoft David", "Samantha"]);
  /* Nothing in the reader's language or English: offer everything rather than nothing. */
  assert.equal(rankDeviceVoices([v("Anna", "de-DE", true)], "fr-FR").length, 1);
});
