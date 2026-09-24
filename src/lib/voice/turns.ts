/* ============================================================================
 * turns.ts — when has someone finished speaking?
 *
 * The hardest question in a voice interface, and the one people judge it by.
 * Answer too early and it talks over you mid-thought; too late and every
 * reply opens with a dead second. Everything a voice product feels like is
 * decided in this file, which is why it is pure and holds no timers: frames
 * come in with a timestamp, events come out, and turns.test.ts can replay a
 * conversation to the millisecond.
 *
 * Four ideas, each from watching how the good ones do it:
 *
 *   **Eager, then sure.** A short pause starts the work — transcribing what
 *   was said — without committing to it. If the pause becomes the end of the
 *   turn, that work is already done; if the speaker carries on, it is thrown
 *   away. This hides most of the transcription behind a silence that had to
 *   be waited out anyway.
 *
 *   **What was said decides how long to wait.** "…and the second thing is"
 *   is not finished however long the pause; "What's a gradient?" is finished
 *   the moment it stops. Once the words are known the wait shrinks or grows to
 *   match — before they are known it sits between the two.
 *
 *   **The floor can be held.** Perplexity's "voice lock": while held, no pause
 *   ends the turn, so you can stop to think, look something up, or read
 *   something out. Letting go ends it at once.
 *
 *   **Talking over it has a higher bar than starting.** A cough, a "mm-hm",
 *   the tail of the app's own voice in the microphone — none of those should
 *   stop a reply. Starting a turn takes 60 ms of voice; interrupting one takes
 *   300, and more again when there is no echo cancellation to trust.
 * ========================================================================== */

import type { TalkSensitivity } from "@/types";

export type TurnEvent =
  /** Someone has started speaking. */
  | { type: "start" }
  /** They spoke over a reply, for long enough to mean it. */
  | { type: "barge" }
  /** A pause long enough to start transcribing, not yet long enough to end on. */
  | { type: "eager" }
  /** They carried on after an eager pause — throw that work away. */
  | { type: "resume" }
  /** The turn is over. `voiced` is how much of it was voice, in ms — what
   *  lib/voice/heard.ts weighs a suspicious transcript against. */
  | { type: "end"; reason: "silence" | "unlock" | "max"; voiced: number }
  /** What started was too short to be speech — a click, a cough. */
  | { type: "discard" };

export interface Timing {
  /** Silence before transcription starts, speculatively. */
  eager: number;
  /** Silence to end on, once the words look finished. */
  complete: number;
  /** Silence to end on, once the words look unfinished. */
  incomplete: number;
  /** Silence to end on while the words are not known yet. */
  unknown: number;
}

export const TIMING: Record<TalkSensitivity, Timing> = {
  quick: { eager: 200, complete: 400, incomplete: 900, unknown: 650 },
  balanced: { eager: 250, complete: 600, incomplete: 1200, unknown: 900 },
  patient: { eager: 300, complete: 1000, incomplete: 2000, unknown: 1500 }
};

/** Voice needed before a turn counts as started. Three frames. */
const ONSET_MS = 60;
/** Less voiced time than this across the whole utterance is not speech. */
const MIN_SPEECH_MS = 220;
/** Voice needed to interrupt a reply, with and without echo cancellation. */
const BARGE_MS = { full: 300, half: 500 };
/** Nobody asks a question for a minute without breathing. */
const MAX_UTTERANCE_MS = 60_000;

/* Words a sentence does not end on. A pause after one of these is a person
   finding the next word, not a person who has finished. */
const TRAILING = new Set(
  (
    "and or but so because cause since though although if then than that which who whose whom where when while " +
    "um uh er erm hmm like the a an to of in on at for with from by about into as is are was were be been my your " +
    "our their his her its this these those i we you they it also plus versus not no maybe"
  ).split(" ")
);

/** Whether a transcript reads as finished. Whisper punctuates; the browser's
 *  own recognition does not, so no punctuation is not evidence either way —
 *  only a trailing conjunction, filler or comma counts against it. */
export function looksComplete(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/(?:,|…|\.\.\.|-|—)$/.test(t)) return false;
  const last = t
    .replace(/[.!?"')\]]+$/, "")
    .split(/\s+/)
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z']/g, "");
  return !(last && TRAILING.has(last));
}

type Phase = "quiet" | "onset" | "speech" | "pause";

export class TurnTaker {
  private phase: Phase = "quiet";
  private onsetAt = 0;
  private voicedMs = 0;
  private startedAt = 0;
  private lastVoiceAt = 0;
  private eagerFired = false;
  private text: string | null = null;
  private locked = false;
  private started = false;
  /** The app is talking. Speech now is a candidate interruption. */
  private replying: "full" | "half" | null = null;
  private barged = false;

  constructor(public timing: Timing) {}

  /** One frame of the microphone, 20 ms or so, at time `t`. */
  frame(speech: boolean, t: number, ms = 20): TurnEvent[] {
    const out: TurnEvent[] = [];
    if (speech) {
      this.lastVoiceAt = t;
      if (this.phase === "quiet") {
        this.phase = "onset";
        this.onsetAt = t;
        this.voicedMs = 0;
        this.startedAt = t;
      }
      this.voicedMs += ms;
      if (this.phase === "onset" && t - this.onsetAt + ms >= ONSET_MS) {
        this.phase = "speech";
      }
      if (this.phase === "pause") {
        this.phase = "speech";
        if (this.eagerFired) {
          this.eagerFired = false;
          this.text = null;
          out.push({ type: "resume" });
        }
      }
      if (this.phase === "speech" && !this.started) {
        if (this.replying) {
          if (!this.barged && this.voicedMs >= BARGE_MS[this.replying]) {
            this.barged = true;
            this.started = true;
            out.push({ type: "barge" });
          }
        } else {
          this.started = true;
          out.push({ type: "start" });
        }
      }
      if (this.started && t - this.startedAt >= MAX_UTTERANCE_MS) {
        out.push(...this.finish("max"));
      }
      return out;
    }

    /* Silence. */
    if (this.phase === "onset") {
      /* A blip that never became speech. Dropped quietly — nothing started. */
      if (t - this.lastVoiceAt > 160) this.phase = "quiet";
      return out;
    }
    if (this.phase === "speech") this.phase = "pause";
    if (this.phase !== "pause") return out;
    if (!this.started) {
      /* Voice while a reply was playing that never reached the barge bar:
         the reply goes on, and this was nothing. */
      if (t - this.lastVoiceAt > 300) this.clear();
      return out;
    }
    if (this.locked) return out;

    const quiet = t - this.lastVoiceAt;
    if (!this.eagerFired && quiet >= this.timing.eager) {
      this.eagerFired = true;
      out.push({ type: "eager" });
    }
    if (quiet >= this.wait()) out.push(...this.finish("silence"));
    return out;
  }

  /** What has been heard so far in this utterance — from the speculative
   *  transcription, or the browser's live recognition. It can end the turn
   *  on its own, when it shows up already past its own deadline. */
  hint(text: string, t: number): TurnEvent[] {
    if (this.phase === "quiet" || !this.started) return [];
    this.text = text;
    if (this.phase === "pause" && !this.locked && t - this.lastVoiceAt >= this.wait()) return this.finish("silence");
    return [];
  }

  /** Hold the floor, or let it go. Letting go of a turn that has started
   *  ends it immediately — that is the point of letting go. */
  lock(on: boolean): TurnEvent[] {
    this.locked = on;
    if (!on && this.started && (this.phase === "pause" || this.phase === "speech")) return this.finish("unlock");
    return [];
  }

  /** The app has started or stopped talking. `half` when echo cancellation
   *  cannot be trusted and interrupting should take more. */
  replyPlaying(mode: "full" | "half" | null): void {
    this.replying = mode;
  }

  /** Forget the utterance in progress. */
  clear(): void {
    this.phase = "quiet";
    this.voicedMs = 0;
    this.eagerFired = false;
    this.text = null;
    this.started = false;
    this.barged = false;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Someone is mid-utterance — for the orb, and for not ending a call on them. */
  get hearing(): boolean {
    return this.started;
  }

  private wait(): number {
    if (this.text == null) return this.timing.unknown;
    return looksComplete(this.text) ? this.timing.complete : this.timing.incomplete;
  }

  private finish(reason: "silence" | "unlock" | "max"): TurnEvent[] {
    const voiced = this.voicedMs;
    this.clear();
    return [voiced >= MIN_SPEECH_MS ? { type: "end", reason, voiced } : { type: "discard" }];
  }
}
