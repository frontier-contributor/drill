/* ============================================================================
 * heard.test.ts — answering nobody, or answering itself.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { isEcho, worthAnswering } from "@/lib/voice/heard";
import { Downsampler, TARGET_RATE, encodeWav } from "@/lib/voice/wav";

test("a recogniser's phantom from a blip of noise is not answered", () => {
  assert.equal(worthAnswering("Thank you.", 0.25), false);
  assert.equal(worthAnswering("Thanks for watching!", 0.3), false);
  assert.equal(worthAnswering("[BLANK_AUDIO]", 2), false);
  assert.equal(worthAnswering("...", 1), false);
});

test("short real answers are answered", () => {
  assert.equal(worthAnswering("Okay.", 0.3), true);
  assert.equal(worthAnswering("Yes", 0.25), true);
  assert.equal(worthAnswering("Thank you.", 0.7), true, "someone really said it");
  assert.equal(worthAnswering("What's backprop?", 0.8), true);
});

test("the app hearing its own sentence is an echo; a real interruption is not", () => {
  const speaking = "Gradient descent takes a small step against the gradient on every iteration.";
  assert.equal(isEcho("takes a small step against the gradient", speaking), true);
  assert.equal(isEcho("wait, stop", speaking), false, "short interruptions always work");
  assert.equal(isEcho("hold on, what does iteration mean here exactly", speaking), false);
});

test("a recording goes out as 16 kHz mono 16-bit WAV, whatever the microphone ran at", () => {
  for (const rate of [48000, 44100, 16000]) {
    const d = new Downsampler(rate);
    let n = 0;
    /* One second in awkward frame sizes: the count must still come out right. */
    for (let left = rate; left > 0; left -= 997) n += d.push(new Float32Array(Math.min(997, left)).fill(0.5)).length;
    assert.ok(Math.abs(n - TARGET_RATE) <= 2, `${rate} Hz gave ${n} samples a second`);
  }
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]));
  assert.equal(wav.size, 44 + 8);
  assert.equal(wav.type, "audio/wav");
});

test("the WAV header says what the bytes are", async () => {
  const buf = new DataView(await encodeWav(new Float32Array(10)).arrayBuffer());
  const tag = (at: number) => String.fromCharCode(buf.getUint8(at), buf.getUint8(at + 1), buf.getUint8(at + 2), buf.getUint8(at + 3));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(buf.getUint16(22, true), 1, "mono");
  assert.equal(buf.getUint32(24, true), TARGET_RATE);
  assert.equal(buf.getUint16(34, true), 16);
  assert.equal(buf.getUint32(40, true), 20);
});
