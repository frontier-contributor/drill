/* ============================================================================
 * capture.ts — the microphone, as frames and as recordings.
 *
 * One getUserMedia stream for the whole call, with the browser's echo
 * cancellation, noise suppression and gain control switched on. They are the
 * same cleanup Perplexity describes running before a sample reaches their
 * servers, and in a browser they are free: the platform runs them, tuned to
 * this device, before this file sees a thing.
 *
 * An AudioWorklet taps the stream on the audio thread and posts 20 ms frames.
 * Everything else happens here on the main thread, in the pure modules it
 * calls, because 50 small messages a second is nothing and pure code can be
 * tested: lib/voice/vad.ts decides "voice or room", lib/voice/wav.ts brings the
 * device's real sample rate down to 16 kHz.
 *
 * The worklet is written out as a string and loaded from a blob URL. It is
 * twenty lines, it imports nothing, and a separate bundled file would mean a
 * build step the rest of the app has never needed.
 *
 * Recording keeps a second of what came *before* someone started speaking.
 * Speech is detected a few frames after it starts, and a recording that began
 * at the detection would lose the first syllable of every question.
 * ========================================================================== */

import { Vad } from "@/lib/voice/vad";
import { Downsampler, TARGET_RATE, concat, encodeWav } from "@/lib/voice/wav";

const FRAME_MS = 20;
/** What is kept from before speech was detected. */
const PREROLL_MS = 600;
/** A recording longer than this is cut: a transcription request has limits,
 *  and turns.ts ends a turn at a minute anyway. */
const MAX_RECORD_MS = 65_000;

const WORKLET = `
class DrillTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(128, Math.round(sampleRate * ${FRAME_MS / 1000}));
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("drill-tap", DrillTap);
`;

export interface CaptureFrame {
  speech: boolean;
  /** 0..1 above the room, for the orb. */
  level: number;
  /** The audio clock, in ms since the call started. */
  t: number;
  ms: number;
}

export interface Recording {
  wav: Blob;
  seconds: number;
}

export interface Capture {
  /** The browser says echo cancellation is running on this microphone. */
  readonly echoCancelled: boolean;
  /** What the system calls the microphone, for Settings' check. Can be "". */
  readonly device: string;
  onFrame(fn: (f: CaptureFrame) => void): void;
  /** Start keeping what is heard, from a little before now. */
  begin(): void;
  /** What has been kept so far, as a WAV, without stopping. */
  snapshot(): Recording | null;
  /** Stop keeping what is heard. */
  end(): void;
  /** Frames stop reaching the detector while muted: silence, not a paused stream. */
  setMuted(on: boolean): void;
  /** dB above the room that counts as a voice — raised while the app talks
   *  without echo cancellation to trust. */
  setMargin(db: number): void;
  /** The time of the last frame, on the same clock as the frames. */
  now(): number;
  close(): void;
}

/** Why the microphone could not be opened, in a sentence someone can act on. */
export function micError(e: unknown): Error {
  const name = (e as { name?: string })?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("Microphone access was refused. Allow it for this site in the browser's address bar, then try again.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new Error("No microphone was found. Plug one in or check the system's sound settings.");
  }
  if (name === "NotReadableError") {
    return new Error("The microphone is in use by another app, or the system would not open it.");
  }
  return new Error("The microphone could not be opened: " + ((e as Error)?.message || String(e)));
}

/**
 * Open the microphone. `ctx` is made by the caller inside the click that
 * started voice mode — an AudioContext created later, after an await, starts
 * suspended on Safari and plays nothing.
 */
export async function openCapture(ctx: AudioContext): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use a microphone here. Voice needs HTTPS or localhost.");
  if (!ctx.audioWorklet) throw new Error("This browser cannot process audio for voice mode. A current Chrome, Edge, Safari or Firefox can.");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
  } catch (e) {
    throw micError(e);
  }

  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);

  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() || {};
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "drill-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  /* Pulled through a silent gain to the output, because a node with no path
     to the destination is not guaranteed to be processed. Nothing is heard. */
  const hush = ctx.createGain();
  hush.gain.value = 0;
  source.connect(tap);
  tap.connect(hush);
  hush.connect(ctx.destination);

  /* The rate the context really runs at — never the one that was asked for. */
  const down = new Downsampler(ctx.sampleRate);
  const vad = new Vad();
  const listeners: ((f: CaptureFrame) => void)[] = [];
  const preroll: Float32Array[] = [];
  let recording: Float32Array[] | null = null;
  let recordedMs = 0;
  let muted = false;
  let clock = 0;
  let closed = false;

  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (closed) return;
    const raw = e.data;
    const ms = (raw.length / ctx.sampleRate) * 1000;
    clock += ms;
    const small = down.push(raw);
    const v = muted ? { speech: false, level: 0 } : vad.frame(raw);

    if (recording) {
      if (recordedMs < MAX_RECORD_MS) {
        recording.push(small);
        recordedMs += ms;
      }
    } else {
      preroll.push(small);
      while (preroll.length > PREROLL_MS / FRAME_MS) preroll.shift();
    }
    const f: CaptureFrame = { speech: v.speech, level: v.level, t: clock, ms };
    for (const fn of listeners) fn(f);
  };

  return {
    echoCancelled: settings.echoCancellation === true,
    device: track?.label || "",
    onFrame(fn) {
      listeners.push(fn);
    },
    begin() {
      recording = preroll.splice(0);
      recordedMs = recording.reduce((n, f) => n + (f.length / TARGET_RATE) * 1000, 0);
    },
    snapshot() {
      if (!recording || !recording.length) return null;
      const samples = concat(recording);
      return { wav: encodeWav(samples), seconds: samples.length / TARGET_RATE };
    },
    end() {
      recording = null;
      recordedMs = 0;
    },
    setMuted(on) {
      muted = on;
      if (track) track.enabled = !on;
      if (on) vad.reset();
    },
    setMargin(db) {
      vad.margin = db;
    },
    now() {
      return clock;
    },
    close() {
      closed = true;
      listeners.length = 0;
      tap.port.onmessage = null;
      try {
        source.disconnect();
        tap.disconnect();
        hush.disconnect();
      } catch {
        /* already gone */
      }
      for (const t of stream.getTracks()) t.stop();
    }
  };
}
