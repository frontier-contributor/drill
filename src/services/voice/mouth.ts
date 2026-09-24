/* ============================================================================
 * mouth.ts — saying a reply while it is still being written.
 *
 * The Listen player (services/speech/player.ts) reads a reply that already
 * exists: it knows every sentence up front and can skip, seek and count down.
 * Voice mode is the other shape — sentences arrive one at a time from
 * lib/voice/chunker.ts while the model is still writing, and the only
 * question is "is there something to say next". So this is its own small
 * queue over the same engines, not a second use of the player.
 *
 * Two things it does that make the difference between talking and reading:
 *
 *   **The next sentence is always being fetched.** While one clip plays the
 *   next is already on its way, so a hosted voice runs sentence into sentence
 *   without the gap a request takes.
 *
 *   **It knows how loud it is.** Each hosted clip is decoded once, off to the
 *   side, into a loudness envelope; the orb reads it at the audio element's
 *   own `currentTime`. Playback itself never goes through Web Audio — Chrome's
 *   echo cancellation hears an <audio> element and would not hear that, and a
 *   voice the microphone cannot subtract is a voice that interrupts itself.
 *   The device voice has no bytes to read, so it pulses on word boundaries.
 *
 * When a hosted voice fails mid-reply, the rest of the reply is said by this
 * device's voice rather than going silent, and the call is told so.
 * ========================================================================== */

import * as store from "@/services/store";
import type { Clip, EngineEvents, PlaybackEngine } from "@/services/speech/player";
import type { SpokenChunk } from "@/lib/voice/chunker";

export interface MouthHooks {
  /** Sound has started for this chunk. */
  started(chunk: SpokenChunk): void;
  /** Everything queued has been said and the reply has ended. */
  drained(): void;
  /** A clip failed. `fellBack` when the device voice has taken over. */
  failed(err: Error, fellBack: boolean): void;
}

/** Loudness in windows of this many seconds. */
const ENV_STEP = 0.025;

export class Mouth {
  private queue: SpokenChunk[] = [];
  private playing: SpokenChunk | null = null;
  private seq = 0;
  private replyEnded = true;
  private paused = false;
  private released = false;
  private el: HTMLAudioElement | null = null;
  private envelopes = new Map<string, Float32Array>();
  private pulse = 0;
  private pulseAt = 0;
  private fellBack = false;

  constructor(
    private engine: PlaybackEngine,
    private hooks: MouthHooks,
    private opts: {
      /** A device voice to fall back on, built on demand. */
      fallback: () => PlaybackEngine | null;
      /** Decode a clip for the orb. Absent, the orb breathes without it. */
      decode?: (blob: Blob) => Promise<AudioBuffer>;
    }
  ) {}

  /** The engine is hosted: its sound goes through an <audio> element that
   *  echo cancellation can subtract. The device voice does not. */
  get cancellable(): boolean {
    return this.engine.id !== "device";
  }

  get speaking(): boolean {
    return !!this.playing && !this.paused;
  }

  /** Something is still to be said, or being said, for the current reply. */
  get busy(): boolean {
    return !!this.playing || this.queue.length > 0 || !this.replyEnded;
  }

  /** What is being said right now — for the echo check and for cutting. */
  get current(): SpokenChunk | null {
    return this.playing;
  }

  get label(): string {
    return this.engine.label;
  }

  /** A new reply is starting. */
  begin(): void {
    this.replyEnded = false;
  }

  say(chunk: SpokenChunk): void {
    if (this.released) return;
    this.queue.push(chunk);
    /* Arrived while another is playing: start fetching it now, so it is ready
       the moment the one before it ends. */
    if (this.playing && this.queue.length === 1) this.engine.prepare({ first: this.seq + 1, last: this.seq + 1, text: chunk.text });
    this.pump();
  }

  /** No more is coming for this reply. */
  end(): void {
    this.replyEnded = true;
    if (!this.playing && !this.queue.length) this.hooks.drained();
  }

  /** Hold the voice — someone may be interrupting. */
  pause(): void {
    this.paused = true;
    this.engine.pause();
  }

  /** It was not an interruption after all. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.playing) this.engine.resume();
    else this.pump();
  }

  /** Stop saying anything, and forget what was queued. Returns what was
   *  playing, so the reply can be cut back to it. */
  stop(): SpokenChunk | null {
    const was = this.playing;
    this.seq++;
    this.queue = [];
    this.playing = null;
    this.paused = false;
    this.replyEnded = true;
    this.engine.pause();
    return was;
  }

  /** 0..1 — how loud the voice is at this moment. */
  level(now: number): number {
    if (!this.playing || this.paused) return 0;
    const env = this.envelopes.get(this.playing.text);
    if (env && this.el) {
      const i = Math.floor(this.el.currentTime / ENV_STEP);
      return env[Math.min(env.length - 1, Math.max(0, i))] || 0;
    }
    /* No envelope: the device voice's word pulses, fading between words, or
       a steady middle while a hosted clip is still being decoded. */
    if (this.engine.id === "device") return this.pulse * Math.exp(-(now - this.pulseAt) / 180);
    return 0.45;
  }

  /** The <audio> element has a new clip. Called by the hosted engine. */
  onAudio(clip: Clip, blob: Blob, el: HTMLAudioElement): void {
    this.el = el;
    if (!this.opts.decode || this.envelopes.has(clip.text)) return;
    const text = clip.text;
    void this.opts
      .decode(blob)
      .then((buf) => {
        const data = buf.getChannelData(0);
        const step = Math.max(1, Math.round(buf.sampleRate * ENV_STEP));
        const env = new Float32Array(Math.ceil(data.length / step));
        let max = 1e-6;
        for (let w = 0; w < env.length; w++) {
          let sum = 0;
          const from = w * step;
          const to = Math.min(data.length, from + step);
          for (let i = from; i < to; i++) sum += data[i] * data[i];
          env[w] = Math.sqrt(sum / Math.max(1, to - from));
          if (env[w] > max) max = env[w];
        }
        for (let w = 0; w < env.length; w++) env[w] = Math.min(1, env[w] / max);
        this.envelopes.set(text, env);
        /* Only the clips around now are worth keeping. */
        while (this.envelopes.size > 4) this.envelopes.delete(this.envelopes.keys().next().value as string);
      })
      .catch(() => undefined);
  }

  release(): void {
    this.released = true;
    this.stop();
    this.engine.release();
    this.envelopes.clear();
    this.el = null;
  }

  private pump(): void {
    if (this.released || this.paused || this.playing || !this.queue.length) return;
    const chunk = this.queue.shift()!;
    this.playing = chunk;
    const my = ++this.seq;
    const clip: Clip = { first: my, last: my, text: chunk.text };
    const rate = store.settings().speech.rate;

    const ev: EngineEvents = {
      started: () => {
        if (my !== this.seq) return;
        this.hooks.started(chunk);
      },
      progress: () => {
        if (my !== this.seq) return;
        this.pulse = 0.55 + Math.random() * 0.45;
        this.pulseAt = performance.now();
      },
      ended: () => {
        if (my !== this.seq) return;
        this.playing = null;
        if (this.queue.length) this.pump();
        else if (this.replyEnded) this.hooks.drained();
      },
      failed: (err) => {
        if (my !== this.seq) return;
        this.playing = null;
        if (!this.fellBack && this.engine.id !== "device") {
          const next = this.opts.fallback();
          if (next) {
            this.fellBack = true;
            this.engine.release();
            this.engine = next;
            this.hooks.failed(err, true);
            /* Say the sentence that failed again, in the new voice. */
            this.queue.unshift(chunk);
            this.pump();
            return;
          }
        }
        this.hooks.failed(err, false);
        if (this.queue.length) this.pump();
        else if (this.replyEnded) this.hooks.drained();
      }
    };

    this.engine.play(clip, 0, rate, ev);
    const next = this.queue[0];
    if (next) this.engine.prepare({ first: my + 1, last: my + 1, text: next.text });
  }
}
