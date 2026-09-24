/* ============================================================================
 * names.ts — what a voice is called on a tile, rather than in an API.
 *
 * A picker of voices is judged by whether you can tell them apart before you
 * press one, and the ids providers use were not written for that: Kokoro's
 * "bm_fable" packs an accent and a gender into two letters, and a Windows
 * voice arrives as "Microsoft Aria Online (Natural) - English (United
 * States)". This turns each into a name and a short second line. Where there
 * is nothing to decode — Orpheus's "hannah", OpenAI's "alloy" — the id is
 * already a name and is only capitalised.
 * ========================================================================== */

export interface VoiceName {
  name: string;
  /** Accent, gender or language, when anything says so. Can be "". */
  detail: string;
}

/* The first letter of a Kokoro voice is its language and accent, the second
   its gender — the convention every Kokoro host keeps. */
const KOKORO: Record<string, string> = {
  a: "American",
  b: "British",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  j: "Japanese",
  p: "Brazilian",
  z: "Mandarin"
};

function titled(s: string): string {
  return s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** A hosted voice id, as a name. */
export function hostedVoiceName(id: string): VoiceName {
  const k = /^([a-z])([fm])_([a-z0-9]+)$/.exec(id);
  if (k && KOKORO[k[1]]) {
    return { name: titled(k[3]), detail: `${KOKORO[k[1]]} · ${k[2] === "f" ? "female" : "male"}` };
  }
  return { name: titled(id.replace(/-playai$/i, "")), detail: "" };
}

/**
 * A voice this browser owns, from the label Listening's list gives it —
 * "<name> · <lang>[ · online]". The vendor and the language spelt out inside
 * the name are dropped, because the second line already says the language.
 */
export function deviceVoiceName(label: string): VoiceName {
  const [raw, lang = "", online] = label.split(" · ");
  const name =
    raw
      .replace(/^(Microsoft|Google|Apple)\s+/i, "")
      .split(" - ")[0]
      .replace(/\s*\([^)]*\)/g, "")
      .replace(/\s+Online$/i, "")
      .trim() || raw;
  return { name, detail: [lang, online].filter(Boolean).join(" · ") };
}
