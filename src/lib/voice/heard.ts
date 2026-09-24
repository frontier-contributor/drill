/* ============================================================================
 * heard.ts — was that worth answering?
 *
 * Two ways a voice interface answers something nobody said.
 *
 * **Whisper's ghosts.** Hand a speech recogniser a second of room noise and it
 * does not return nothing; it returns the sentence it heard most often in
 * training at the end of a video — "Thank you.", "Thanks for watching!",
 * "you". An assistant that replies "You're welcome!" to the sound of a chair
 * is the first thing anyone notices and the last thing they forgive. So a
 * short recording that transcribes to one of those, or to nothing that is a
 * word, is dropped.
 *
 * **Its own voice.** Echo cancellation is good, not perfect: a laptop speaker
 * at full volume leaks, and what leaks is the sentence the app is saying. If
 * an interruption transcribes to mostly the words being spoken at that
 * moment, it was the app hearing itself, and the reply carries on.
 *
 * Pure. heard.test.ts holds both.
 * ========================================================================== */

/* Said by recognisers to silence and noise, lower-cased and unpunctuated. */
const GHOSTS = new Set([
  "you",
  "thank you",
  "thank you very much",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching bye",
  "please subscribe",
  "hmm",
  "um",
  "uh",
  "the",
  "subtitles by the amaraorg community",
  "music"
]);

function words(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Worth sending to the model: has a word in it, and is not a phantom.
 *
 *  `voiced` is how many seconds of the recording the detector heard as voice,
 *  not how long the recording was — a recording carries a lead-in and a
 *  trailing pause either way. A person saying "thank you" to the app voices
 *  around half a second of it and is answered; a creak or a tap that only just
 *  cleared the detector voiced a few tenths and comes back as "Thank you." for
 *  no reason. "Okay", "yes" and "bye" are never on the list: they are real
 *  answers to a real question. */
export function worthAnswering(text: string, voiced: number): boolean {
  const w = words(text);
  if (!w.length) return false;
  if (/^\[.*\]$|^\(.*\)$/.test(text.trim())) return false; // "[BLANK_AUDIO]", "(music)"
  if (voiced < 0.4 && GHOSTS.has(w.join(" "))) return false;
  return true;
}

/**
 * Whether what was heard is the app's own voice coming back.
 *
 * Measured as the share of the heard words that appear in what was being
 * said — heard words, not spoken ones, because a real interruption is usually
 * short and the sentence being read is long. Three words or fewer is too little
 * to judge and is treated as real: "wait, stop" must always work.
 */
export function isEcho(heard: string, speaking: string): boolean {
  const h = words(heard);
  if (h.length <= 3) return false;
  const said = new Set(words(speaking));
  if (!said.size) return false;
  const shared = h.filter((x) => said.has(x)).length;
  return shared / h.length >= 0.7;
}
