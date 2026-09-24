/* ============================================================================
 * style.ts — how a reply is written when it is going to be heard.
 *
 * A reply written for the page and read aloud is exhausting: headings are
 * said as sentences, a bulleted list becomes a monotone inventory, a table is
 * a string of numbers with nothing to hang them on. The fix is not in the
 * voice, it is in the writing — so voice mode tells the model it is talking.
 *
 * Two shapes, chosen per conversation:
 *
 *   talk  Only words. Short, spoken, one idea at a time, a question back
 *         instead of a lecture. Nothing is ever put on screen, because there
 *         is nothing to point at.
 *   show  Talking, with a screen beside you. Code, figures and tables may go
 *         in the reply — they appear in the thread and the voice names them
 *         instead of reading them (lib/voice/chunker.ts) — and the spoken part
 *         says what to look at.
 *
 * Appended last, after the persona, the context and the figure protocol, so
 * that when "draw a diagram" and "only words" disagree, the one that knows the
 * reply is being listened to wins.
 *
 * Pure.
 * ========================================================================== */

import type { VoiceStyle } from "@/types";

const SHARED =
  "- What they said reached you through speech recognition, so it may have a wrong word or two. Read it for " +
  "what they meant. If it is garbled or cut off, ask one short question rather than guessing.\n" +
  "- Say maths in words — \"x squared over two\", \"the sum over every example\" — never as symbols.\n" +
  "- Never talk about your formatting, your voice, or being read aloud.";

const TALK =
  "=== YOU ARE TALKING, NOT WRITING ===\n" +
  "This conversation is spoken. Everything you write is read out by a voice, and they are listening, not " +
  "reading.\n" +
  "- Two to four short sentences, the way you would say it across a table. Longer only when they ask for depth, " +
  "and even then in short spoken sentences.\n" +
  "- Plain speech only: no markdown, headings, bullet points, numbered lists, tables, code blocks, links or " +
  "emoji. Nothing will be shown on a screen.\n" +
  "- One idea at a time. If there is more to say, give the first part and offer the rest.\n" +
  "- When it helps the conversation move, end on a short question. Not every time.\n" +
  SHARED;

const SHOW =
  "=== YOU ARE TALKING, WITH A SCREEN BESIDE YOU ===\n" +
  "This conversation is spoken, and there is a screen beside it. Your prose is read aloud. Code blocks, figures " +
  "and tables are not read — they are shown on the screen.\n" +
  "- Keep the spoken part short: two to five natural sentences.\n" +
  "- When something is clearer seen than heard — code, a diagram, a chart, a table — put it in the reply, and " +
  "say in a sentence what it shows and what to look at. Never spell code out in prose.\n" +
  "- No headings or bullet lists in the spoken part; those are for reading, not listening.\n" +
  SHARED;

export function voiceBrief(style: VoiceStyle): string {
  return style === "show" ? SHOW : TALK;
}

/** The ceiling on a spoken reply, in tokens. Talk is meant to be short, and a
 *  cap is what stops a model that ignores that from reading out an essay. It
 *  is generous enough that a reasoning model's scratchpad does not eat the
 *  answer; Show gets the thread's own budget, because code is long. */
export function voiceMaxTokens(style: VoiceStyle, threadMax: number): number {
  return style === "talk" ? Math.min(threadMax, 1200) : threadMax;
}
