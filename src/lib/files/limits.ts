/* ============================================================================
 * limits.ts — how much of a file is read, and what a refusal says.
 *
 * The limits exist for the browser, not the model. A 400-page PDF is read page
 * by page on the main thread's doorstep; a 60MB photo is decoded into a bitmap
 * four times its compressed size before it can be shrunk. Past these numbers
 * the tab stalls, which is worse than a sentence saying why nothing happened.
 *
 * Pure.
 * ========================================================================== */
import type { FileKind } from "./sniff";

export const MB = 1024 * 1024;

export const LIMITS: Record<Exclude<FileKind, "unsupported">, number> = {
  text: 5 * MB,
  image: 20 * MB,
  pdf: 50 * MB,
  doc: 25 * MB,
  sheet: 25 * MB
};

const NOUN: Record<Exclude<FileKind, "unsupported">, string> = {
  text: "Text",
  image: "Image",
  pdf: "PDF",
  doc: "Word",
  sheet: "Excel"
};

/** Extracted text kept per file: about a hundred thousand tokens, more than a
 *  whole textbook chapter and more than most models' windows. */
export const MAX_TEXT_CHARS = 400_000;
export const MAX_PDF_PAGES = 400;
/** The long edge an image is sent at. Anthropic's guidance, and close to what
 *  every other provider downscales to on arrival — anything larger is paid
 *  for in upload time and then thrown away on their side. */
export const IMAGE_LONG_EDGE = 1568;
export const THUMB_EDGE = 112;
/** Scanned PDF pages rendered as pictures, at most. Each one costs about as
 *  much as a photo, and a whole scanned book would be a bill, not a message. */
export const MAX_PAGE_IMAGES = 8;
/** Rows of a table given to the model before it is told how many more there are. */
export const MAX_TABLE_ROWS = 500;

export function commas(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** Null when it fits; the sentence to show when it does not. */
export function tooLarge(kind: Exclude<FileKind, "unsupported">, bytes: number, name: string): string | null {
  const limit = LIMITS[kind];
  if (bytes <= limit) return null;
  return `"${name}" is ${size(bytes)}. ${NOUN[kind]} files up to ${size(limit)} can be attached.`;
}

/** Cut to the limit and say so in the text itself, so the model knows it has
 *  not seen the end rather than answering as if it had. */
export function clipText(text: string, max = MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n\n[… ${commas(text.length - max)} more characters were not included]`,
    truncated: true
  };
}
