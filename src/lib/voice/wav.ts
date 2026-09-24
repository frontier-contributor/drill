/* ============================================================================
 * wav.ts — what a recording is sent as.
 *
 * Every transcription endpoint this app talks to takes WAV, and WAV is the one
 * format that needs no encoder: a 44-byte header and the samples. What it
 * costs is size, which is why it goes out at 16 kHz, mono, 16-bit — the rate
 * speech recognisers are trained at, so nothing they use is thrown away, and
 * a third of what the microphone delivers at 48 kHz. About 32 KB a second: a
 * four-second question uploads in the time a larger file would still be
 * negotiating.
 *
 * The microphone's real rate is whatever the device gave, not what was asked
 * for — mobile Chromium hands back 48 kHz while reporting the rate requested,
 * and a recording labelled with the wrong one comes out as double-speed
 * nonsense. So `Downsampler` is told the rate the AudioContext actually
 * reports, and keeps its place between packets: a resampler that restarts on
 * every 20 ms frame clicks fifty times a second.
 *
 * Pure: no DOM, no audio APIs. wav.test.ts holds the header and the rate.
 * ========================================================================== */

export const TARGET_RATE = 16_000;

/**
 * Streaming sample-rate conversion to 16 kHz.
 *
 * Each output sample is the average of the input samples that fall in its
 * window — a box filter, which is crude as filters go and entirely enough for
 * speech headed to a recogniser: it removes what would alias, and the voice
 * band sits far below the new Nyquist. The window's fractional position
 * carries over from one call to the next, so frames of any length join
 * seamlessly.
 */
export class Downsampler {
  private readonly step: number;
  /** Where the next output sample's window ends, in input samples, counted
   *  from the start of the next frame handed in. */
  private edge: number;
  private sum = 0;
  private count = 0;

  constructor(readonly inputRate: number) {
    this.step = inputRate / TARGET_RATE;
    this.edge = this.step;
  }

  push(frame: Float32Array): Float32Array {
    if (this.step <= 1) return frame.slice();
    const out = new Float32Array(Math.ceil((frame.length + this.count) / this.step) + 1);
    let n = 0;
    for (let i = 0; i < frame.length; i++) {
      this.sum += frame[i];
      this.count++;
      if (i + 1 >= this.edge) {
        out[n++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        this.edge += this.step;
      }
    }
    this.edge -= frame.length;
    return out.subarray(0, n);
  }
}

/** 16-bit little-endian PCM, clipped rather than wrapped: a sample past full
 *  scale wraps round to the opposite sign and is heard as a crack. */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Blob {
  const bytes = 44 + samples.length * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, bytes - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Join frames into one run of samples. */
export function concat(frames: Float32Array[]): Float32Array {
  let len = 0;
  for (const f of frames) len += f.length;
  const out = new Float32Array(len);
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}
