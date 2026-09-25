/* ============================================================================
 * availability.ts — can anything read this aloud, and which voice should?
 *
 * The Think switch taught this app that "does the backend support it" is not
 * the whole question. Reading aloud is the same shape one level further out:
 * whether OpenRouter can speak depends on a key being saved for it, on the
 * chosen model still being one of its speech models, and on the voice being
 * one that model actually has. This device's own voice depends on a list the
 * browser loads whenever it gets round to it.
 *
 * Three answers, the same three lib/thinking.ts gives:
 *
 *   yes      it will work
 *   no       it cannot, and `why` names the fix
 *   unknown  a list it depends on has not loaded yet
 *
 * `unknown` stays usable. Rounding "not loaded yet" down to "no" would grey
 * the Listen button out for the first second of every visit, and on every
 * visit where the catalogue fetch fails. Only a list that has loaded and
 * leaves something out produces a no — and nothing here ever decides what a
 * voice can do from its name.
 *
 * Pure, so availability.test.ts can walk every branch without a browser.
 * ========================================================================== */
import type { SpeechEngineId } from "@/types";

export interface SpeechVerdict {
  can: boolean;
  /** False while a list this depends on is still loading. */
  certain: boolean;
  /** One sentence, written for a tooltip or a disabled row. */
  why: string;
}

function shortName(model: string): string {
  return model.split("/").pop() || model;
}

/* ----------------------------------------------------------------- device -- */

export interface DeviceFacts {
  /** `speechSynthesis` exists at all. */
  supported: boolean;
  /** How many voices the browser offers; null while it is still loading them. */
  voices: number | null;
}

export function deviceVerdict(f: DeviceFacts): SpeechVerdict {
  if (!f.supported) return { can: false, certain: true, why: "This browser has no built-in voices." };
  if (f.voices === null) return { can: true, certain: false, why: "This browser's voices are still loading." };
  if (f.voices === 0) {
    return {
      can: false,
      certain: true,
      why: "This browser has no voices installed — common on Linux. Install one, or use a hosted voice."
    };
  }
  return { can: true, certain: true, why: "This device's own voice. Free, and works offline." };
}

/* ----------------------------------------------------------------- hosted -- */

export interface HostedFacts {
  label: string;
  /** The backend declares a speech endpoint at all. */
  speaks: boolean;
  needsKey: boolean;
  hasKey: boolean;
  source: "catalogue" | "fixed" | "typed";
  model: string;
  /** The voices this model offers: a list when known, null while the list is
   *  loading, undefined when a loaded list does not include the model. */
  voices: readonly string[] | null | undefined;
}

export function hostedVerdict(f: HostedFacts): SpeechVerdict {
  if (!f.speaks) return { can: false, certain: true, why: `${f.label} cannot read aloud.` };
  if (f.needsKey && !f.hasKey) {
    return { can: false, certain: true, why: `Add your ${f.label} key under Settings → Connection to use its voices.` };
  }
  if (!f.model) return { can: false, certain: true, why: "Pick a speech model first." };
  if (f.source === "typed") {
    return {
      can: true,
      certain: false,
      why: "Not sure this server can speak until it is asked — it will say so if it cannot."
    };
  }
  if (f.voices === null) return { can: true, certain: false, why: `The list of ${f.label} voices has not loaded yet.` };
  if (f.voices === undefined) {
    return {
      can: false,
      certain: true,
      why: `${shortName(f.model)} is not one of ${f.label}'s speech models. Pick another under Settings → Listening.`
    };
  }
  if (!f.voices.length) {
    /* Not a refusal. Some models take a voice id from their own library
       rather than publishing a list — Fish Audio's four do — and speak in a
       default voice when given none. Offered as a hedge, like a typed server:
       the request says so if the voice is wrong. */
    return {
      can: true,
      certain: false,
      why: `${shortName(f.model)} publishes no voice list — it uses its default voice unless you name one.`
    };
  }
  return { can: true, certain: true, why: `${shortName(f.model)} via ${f.label}.` };
}

/** The voice to use: the one asked for if this model has it, then the
 *  backend's default, then whatever the model lists first. Switching model
 *  therefore never leaves a voice selected that the new model would refuse. */
export function pickVoice(voices: readonly string[], wanted: string, preferred: string): string {
  if (wanted && voices.includes(wanted)) return wanted;
  if (preferred && voices.includes(preferred)) return preferred;
  return voices[0] || wanted || preferred;
}

/* ----------------------------------------------------------------- choice -- */

export interface EngineChoice {
  engine: SpeechEngineId | null;
  /** Set when the engine asked for could not be used and another stood in —
   *  said in the popover, so a voice that changed is never a mystery. */
  fellBack: string | null;
}

/**
 * Which engine actually reads, given what was asked for and what can.
 *
 * Automatic means OpenRouter when it can speak, otherwise this device. Groq
 * and custom servers are never picked automatically: Groq's free tier takes
 * 200 characters a request and a hundred requests a day, and a custom server
 * is a guess until it answers.
 *
 * A chosen engine that stops working — the key was removed, the model
 * retired — falls back to this device's voice and says why, rather than
 * leaving a Listen button that fails every time it is pressed.
 */
export function chooseEngine(pref: SpeechEngineId | "", verdicts: Record<SpeechEngineId, SpeechVerdict>): EngineChoice {
  if (!pref) {
    if (verdicts.openrouter.can) return { engine: "openrouter", fellBack: null };
    if (verdicts.device.can) return { engine: "device", fellBack: null };
    return { engine: null, fellBack: null };
  }
  if (verdicts[pref].can) return { engine: pref, fellBack: null };
  if (pref !== "device" && verdicts.device.can) return { engine: "device", fellBack: verdicts[pref].why };
  return { engine: null, fellBack: verdicts[pref].why };
}

/* ---------------------------------------------------------- device voices -- */

export interface VoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

function langOf(tag: string): string {
  return String(tag || "").replace("_", "-").slice(0, 2).toLowerCase();
}

/**
 * The browser's voices worth offering, best first.
 *
 * Filtered to the reader's language plus English, because replies in this
 * app are written in English and a list of 180 voices is not a choice anyone
 * can make. Network voices sort first: `localService: false` is how the
 * browser marks the voices it streams, and those are the neural ones (Edge's
 * "Natural" set, Chrome's Google voices) — a property of the voice, not a
 * guess from its name.
 */
export function rankDeviceVoices<T extends VoiceLike>(voices: readonly T[], uiLang: string): T[] {
  const want = langOf(uiLang) || "en";
  const fit = voices.filter((v) => langOf(v.lang) === want || langOf(v.lang) === "en");
  const pool = fit.length ? fit : [...voices];
  const score = (v: T) => (langOf(v.lang) === want ? 4 : 0) + (v.localService ? 0 : 2) + (v.default ? 1 : 0);
  return [...pool].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
