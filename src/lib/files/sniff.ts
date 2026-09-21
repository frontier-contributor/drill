/* ============================================================================
 * sniff.ts — what a file actually is, from its first bytes.
 *
 * The file picker's accept list and the browser's `type` are both hints. A
 * screenshot saved as .jpg is often a PNG; a CSV from a spreadsheet export can
 * arrive as application/vnd.ms-excel; a PDF downloaded through a proxy can come
 * with no type at all. Reading a few magic bytes is cheap and it is the only
 * answer that is not a guess, so the bytes win and the name and type are only
 * consulted for what bytes cannot tell apart — a .docx and an .xlsx are both
 * zip archives.
 *
 * Everything this refuses says what to do instead. "Unsupported file" is the
 * grey-button failure again: a no with no way forward.
 *
 * Pure: the caller reads the head of the file.
 * ========================================================================== */

export type FileKind = "image" | "pdf" | "doc" | "sheet" | "text" | "unsupported";

export interface Sniffed {
  kind: FileKind;
  /** An image's real type, from its bytes. */
  mime?: string;
  /** CSV or TSV — read into a table rather than passed through raw. */
  tabular?: boolean;
  /** Text that is not UTF-8, when the bytes say so. */
  encoding?: "utf-16le" | "utf-16be";
  /** For anything refused: what to do instead, in one sentence. */
  why?: string;
}

/** How many bytes sniffing wants. Enough for every magic number here and for a
 *  fair look at whether the rest is text. */
export const SNIFF_BYTES = 4096;

/**
 * Every extension read as text, as a list rather than as a regex.
 *
 * It is a list because two things need it: this file, which decides what is
 * actually read, and lib/files/kinds.ts, which opens the file dialog on it.
 * Those drifting apart is a menu that offers a file ingest then refuses, so
 * there is one list and the regex below is built from it.
 */
export const TEXT_EXTENSIONS = [
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "org", "tex", "bib", "log",
  "json", "jsonl", "ndjson", "ipynb", "csv", "tsv", "xml", "svg",
  "html", "htm", "css", "scss", "less",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
  "py", "pyw", "r", "rmd", "jl", "m", "sql",
  "java", "kt", "kts", "scala", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "go", "rs", "rb",
  "php", "swift", "lua", "pl", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "toml", "yaml", "yml", "ini", "cfg", "conf", "env", "properties",
  "gradle", "proto", "graphql", "gql", "diff", "patch"
];

const TEXT_EXT = new RegExp("\.(" + TEXT_EXTENSIONS.join("|") + ")$", "i");

const TEXT_MIME =
  /^(text\/|application\/(json|ld\+json|xml|javascript|x-javascript|typescript|x-sh|x-python|sql|x-tex|x-yaml|yaml|toml|x-ndjson)|image\/svg\+xml)/i;

const MEDIA_EXT = /^(mp3|wav|m4a|aac|ogg|oga|flac|opus|mp4|m4v|mov|webm|mkv|avi|wmv)$/;

function at(head: Uint8Array, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (head[offset + i] !== bytes[i]) return false;
  return true;
}

function ascii(head: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = offset; i < offset + length && i < head.length; i++) s += String.fromCharCode(head[i]);
  return s;
}

function extOf(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function quoted(name: string): string {
  return name ? `"${name}"` : "That file";
}

function refuse(why: string): Sniffed {
  return { kind: "unsupported", why };
}

export function sniff(name: string, mime: string, head: Uint8Array): Sniffed {
  const ext = extOf(name);
  const type = String(mime || "").toLowerCase();

  if (at(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: "pdf" };

  if (at(head, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png" };
  if (at(head, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (at(head, [0x47, 0x49, 0x46, 0x38])) return { kind: "image", mime: "image/gif" };
  if (at(head, [0x52, 0x49, 0x46, 0x46]) && at(head, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: "image", mime: "image/webp" };
  if (at(head, [0x42, 0x4d]) && ext === "bmp") return { kind: "image", mime: "image/bmp" };

  /* ISO media: HEIC and AVIF pictures share the box format with MP4 and MOV
     video, so the brand is what separates a photo from a film. */
  if (at(head, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = ascii(head, 8, 4);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return { kind: "image", mime: "image/heic" };
    if (/^(avif|avis)$/.test(brand)) return { kind: "image", mime: "image/avif" };
    return refuse(`${quoted(name)} is audio or video, which is not read. Attach a transcript of it instead.`);
  }

  if (at(head, [0x50, 0x4b, 0x03, 0x04]) || at(head, [0x50, 0x4b, 0x05, 0x06])) {
    if (ext === "docx" || type.includes("wordprocessingml")) return { kind: "doc" };
    if (ext === "xlsx" || ext === "xlsm" || type.includes("spreadsheetml")) return { kind: "sheet" };
    if (ext === "pptx" || type.includes("presentationml")) {
      return refuse("PowerPoint files are not read yet. Export the slides as a PDF and attach that.");
    }
    if (ext === "odt" || ext === "ods" || ext === "odp") {
      return refuse("OpenDocument files are not read. Save it as .docx, .xlsx or PDF and attach that.");
    }
    if (ext === "epub") return refuse("EPUB books are not read. Attach the chapter you want as a PDF or as text.");
    return refuse(`${quoted(name)} is a zip archive. Attach the files inside it instead.`);
  }

  if (at(head, [0xd0, 0xcf, 0x11, 0xe0])) {
    return refuse("That is the old Word or Excel format (.doc, .xls). Save it as .docx or .xlsx and attach that.");
  }

  if (/^(audio|video)\//.test(type) || MEDIA_EXT.test(ext)) {
    return refuse(`${quoted(name)} is audio or video, which is not read. Attach a transcript of it instead.`);
  }
  if (type.startsWith("image/") && type !== "image/svg+xml") {
    return refuse(`${quoted(name)} is an image format this app cannot read. Convert it to PNG or JPEG and attach it again.`);
  }

  const tabular = ext === "csv" || ext === "tsv" || type === "text/csv" || type === "text/tab-separated-values";

  /* UTF-16 text is full of zero bytes, which would otherwise read as binary. */
  if (at(head, [0xff, 0xfe])) return { kind: "text", tabular, encoding: "utf-16le" };
  if (at(head, [0xfe, 0xff])) return { kind: "text", tabular, encoding: "utf-16be" };

  if (TEXT_EXT.test(name || "") || TEXT_MIME.test(type)) {
    return looksLikeText(head)
      ? { kind: "text", tabular }
      : refuse(`${quoted(name)} is named like text but is binary inside. Attach it as a PDF, or copy the text out of it.`);
  }
  /* README, LICENSE, Makefile: no extension, and plainly text. */
  if (looksLikeText(head)) return { kind: "text", tabular };

  return refuse(`${quoted(name)} is not a file this app can read. Text, code, CSV, PDF, Word, Excel and images are.`);
}

/** No zero bytes, and control characters are rare — about what `file(1)`
 *  checks, and enough to tell a source file from a compiled one. */
export function looksLikeText(head: Uint8Array): boolean {
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  return control <= head.length * 0.1;
}
