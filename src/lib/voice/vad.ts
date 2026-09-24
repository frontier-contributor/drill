/* ============================================================================
 * vad.ts — is someone speaking in this 20 ms of audio?
 *
 * Energy against a moving floor. Deliberately not a neural detector: those
 * mean a model file and a WASM runtime in the bundle, and the browser has
 * already done the expensive half — getUserMedia's noise suppression and echo
 * cancellation run before a sample reaches this file. What is left is to tell
 * a voice from the room, and a room is quiet relative to a voice even when it
 * is loud in absolute terms. So the question is never "is this loud" but "is
 * this well above what this room has sounded like lately".
 *
 * The floor follows the room down immediately and up slowly, and only while
 * nobody is speaking — a floor that learned from speech would climb until it
 * could no longer hear speech. Hysteresis keeps a word from flickering in and
 * out on its quieter syllables.
 *
 * `margin` is the knob the session turns: while the app is talking without
 * trustworthy echo cancellation, the bar for "that was a person" goes up, so
 * the speaker's own voice leaking into the microphone is not an interruption.
 *
 * Pure. The numbers in here are where a real room should tune them; they have
 * been reasoned about, not yet measured against a microphone.
 * ========================================================================== */

export interface VadFrame {
  speech: boolean;
  /** 0..1, how far above the floor — what the orb breathes with. */
  level: number;
  db: number;
}

const FLOOR_MIN = -80;
const FLOOR_MAX = -32;
/** Anything quieter than this is not speech however quiet the room. */
const ABS_MIN = -52;
/** Once speaking, this much less margin keeps it speaking. */
const HOLD = 5;
/** How many dB above the floor reads as a full-volume orb. */
const RANGE = 30;

export class Vad {
  private floor = -60;
  private warm = 0;
  private speaking = false;
  private smooth = 0;
  /** dB above the floor that counts as a voice. */
  margin = 12;

  frame(samples: Float32Array): VadFrame {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const db = 20 * Math.log10(rms + 1e-9);

    /* The first quarter second sets the floor from what the room actually
       sounds like, rather than assuming a studio. */
    if (this.warm < 12) {
      this.floor = this.warm === 0 ? db : Math.min(this.floor, db);
      this.warm++;
    }

    const bar = Math.max(this.floor + this.margin - (this.speaking ? HOLD : 0), ABS_MIN);
    this.speaking = db > bar;

    if (!this.speaking) {
      this.floor = db < this.floor ? db : this.floor * 0.97 + db * 0.03;
    }
    this.floor = Math.max(FLOOR_MIN, Math.min(FLOOR_MAX, this.floor));

    const raw = Math.max(0, Math.min(1, (db - this.floor) / RANGE));
    /* Fast attack, slow release: a syllable lands at once and fades rather
       than blinking off between words. */
    this.smooth = raw > this.smooth ? raw * 0.6 + this.smooth * 0.4 : raw * 0.15 + this.smooth * 0.85;
    return { speech: this.speaking, level: this.smooth, db };
  }

  reset(): void {
    this.speaking = false;
    this.smooth = 0;
  }
}
