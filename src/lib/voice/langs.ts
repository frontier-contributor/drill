/* ============================================================================
 * langs.ts — the language you speak to voice mode in, said two ways.
 *
 * The two kinds of ears want different spellings of the same answer. Whisper
 * takes an ISO 639-1 code ("hi") and, given none, guesses from the audio —
 * which it does well on a paragraph and badly on "yes, go on", where a short
 * English phrase can come back as Welsh. The browser's recognition takes a
 * BCP 47 tag ("hi-IN") and has no guess at all: it listens for whatever it is
 * told, which is why "automatic" there means the browser's own language.
 *
 * So the setting is stored once, as the code, and the tag is derived — using
 * this browser's own region when it speaks the same language, because en-GB
 * recognises a British speaker better than the en-US a table would pick.
 * ========================================================================== */

export interface TalkLang {
  /** ISO 639-1, what Whisper is sent. */
  id: string;
  name: string;
  /** The BCP 47 tag used when this browser's own language is a different one. */
  tag: string;
}

/* The languages every engine here hears well, in roughly the order people
   using this app speak them. Whisper takes ninety-odd; a list of ninety is a
   list nobody scrolls, and "Automatic" still hears the rest. */
export const TALK_LANGS: TalkLang[] = [
  { id: "en", name: "English", tag: "en-US" },
  { id: "hi", name: "Hindi", tag: "hi-IN" },
  { id: "es", name: "Spanish", tag: "es-ES" },
  { id: "fr", name: "French", tag: "fr-FR" },
  { id: "de", name: "German", tag: "de-DE" },
  { id: "pt", name: "Portuguese", tag: "pt-BR" },
  { id: "it", name: "Italian", tag: "it-IT" },
  { id: "nl", name: "Dutch", tag: "nl-NL" },
  { id: "ru", name: "Russian", tag: "ru-RU" },
  { id: "pl", name: "Polish", tag: "pl-PL" },
  { id: "tr", name: "Turkish", tag: "tr-TR" },
  { id: "ar", name: "Arabic", tag: "ar-SA" },
  { id: "ja", name: "Japanese", tag: "ja-JP" },
  { id: "ko", name: "Korean", tag: "ko-KR" },
  { id: "zh", name: "Chinese", tag: "zh-CN" },
  { id: "bn", name: "Bengali", tag: "bn-IN" },
  { id: "mr", name: "Marathi", tag: "mr-IN" },
  { id: "ta", name: "Tamil", tag: "ta-IN" },
  { id: "te", name: "Telugu", tag: "te-IN" },
  { id: "ur", name: "Urdu", tag: "ur-PK" }
];

/**
 * The tag the browser's recognition listens with.
 *
 * `uiLang` is `navigator.language`. Hinglish is English as it is spoken in
 * India, and en-IN recognises it far better than en-US does, so the tutor's
 * Hinglish setting still steers English when nothing more specific is chosen.
 */
export function recognitionTag(lang: string, uiLang: string, hinglish: boolean): string {
  const ui = uiLang || "en-US";
  const uiBase = ui.split("-")[0].toLowerCase();
  if (!lang) return hinglish ? "en-IN" : ui;
  if (lang === "en" && hinglish) return "en-IN";
  if (uiBase === lang && ui.includes("-")) return ui;
  return TALK_LANGS.find((l) => l.id === lang)?.tag || lang;
}
