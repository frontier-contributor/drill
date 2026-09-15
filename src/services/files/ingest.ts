/* ============================================================================
 * ingest.ts — one way in for every file, from every place that accepts one.
 *
 * The chat composer, a project's knowledge and the journal's capture box each
 * read files, and each used to have its own FileReader that accepted .md and
 * .txt. This is the one path now: sniff what the file really is, refuse it with
 * a sentence if it cannot be read, and otherwise turn it into an Attachment —
 * text the model reads, plus, for chat, the original bytes kept in drill-files.
 *
 * The parsers are imported when a file of their kind arrives, so pdf.js,
 * mammoth and the spreadsheet reader cost nothing until they are used and never
 * reach the review loop.
 * ========================================================================== */
import * as U from "@/lib/util";
import { SNIFF_BYTES, sniff } from "@/lib/files/sniff";
import { MAX_TABLE_ROWS, clipText, tooLarge } from "@/lib/files/limits";
import { describeTable, parseDelimited, sniffDelimiter } from "@/lib/files/csv";
import * as files from "./db";
import type { Attachment } from "@/types/chat";

export interface IngestProgress {
  label: string;
  done?: number;
  total?: number;
}

export interface IngestOptions {
  signal?: AbortSignal;
  onProgress?: (p: IngestProgress) => void;
  /**
   * `chat` keeps the original bytes and renders what a model that can see
   * needs. `text` is for project knowledge and the journal, which hold text
   * only: pictures are refused there and nothing goes into the file store.
   */
  purpose?: "chat" | "text";
}

export async function ingest(file: File, opts: IngestOptions = {}): Promise<Attachment> {
  const purpose = opts.purpose || "chat";
  const name = file.name || "untitled";
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const kind = sniff(name, file.type, head);
  if (kind.kind === "unsupported") throw new Error(kind.why || "That file cannot be read.");
  const big = tooLarge(kind.kind, file.size, name);
  if (big) throw new Error(big);

  const id = U.uid("a");
  const base = { id, name, size: file.size };
  const say = (label: string) => opts.onProgress?.({ label });

  if (kind.kind === "text") {
    say("Reading");
    const raw = kind.encoding ? new TextDecoder(kind.encoding).decode(await file.arrayBuffer()) : await file.text();
    if (kind.tabular) {
      const { rows, total } = parseDelimited(raw, sniffDelimiter(raw.slice(0, 20_000), name), MAX_TABLE_ROWS);
      const table = describeTable(`"${name}"`, rows, total, MAX_TABLE_ROWS);
      return { ...base, kind: "file", text: table.text, truncated: table.truncated };
    }
    const c = clipText(raw);
    return { ...base, kind: "file", text: c.text, truncated: c.truncated };
  }

  if (kind.kind === "image") {
    if (purpose === "text") {
      throw new Error("Pictures cannot be kept here, only text. Attach it in a chat instead, where a model that can see will read it.");
    }
    say("Preparing");
    const { prepareImage } = await import("./image");
    const img = await prepareImage(file, kind.mime || file.type);
    await keep({ id, name, mime: img.mime, size: img.blob.size, created: Date.now(), blob: img.blob });
    return {
      ...base,
      kind: "image",
      text: "",
      size: img.blob.size,
      fileId: id,
      mime: img.mime,
      dims: { w: img.w, h: img.h },
      thumb: img.thumb
    };
  }

  if (kind.kind === "pdf") {
    say("Reading");
    const { readPdf } = await import("./pdf");
    const pdf = await readPdf(file, {
      signal: opts.signal,
      renderScans: purpose === "chat",
      onProgress: (done, total) => opts.onProgress?.({ label: "Reading page", done, total })
    });
    const c = clipText(pdf.text);
    const att: Attachment = {
      ...base,
      kind: "pdf",
      text: c.text,
      truncated: c.truncated || pdf.readPages < pdf.pages,
      pages: pdf.pages,
      scanned: pdf.scanned.length ? pdf.scanned : undefined,
      thumb: pdf.thumb,
      mime: "application/pdf"
    };
    if (purpose === "chat") {
      await keep({ id, name, mime: "application/pdf", size: file.size, created: Date.now(), blob: file });
      att.fileId = id;
      if (pdf.pageImages.length) {
        const ids: string[] = [];
        for (let i = 0; i < pdf.pageImages.length; i++) {
          const pageId = `${id}-p${pdf.scanned[i]}`;
          const blob = pdf.pageImages[i];
          await keep({ id: pageId, name: `${name} · page ${pdf.scanned[i]}`, mime: "image/jpeg", size: blob.size, created: Date.now(), blob });
          ids.push(pageId);
        }
        att.pageImages = ids;
      }
    }
    return att;
  }

  if (kind.kind === "doc") {
    say("Reading");
    const { readDocx } = await import("./docx");
    const c = clipText(await readDocx(file));
    return { ...base, kind: "doc", text: c.text, truncated: c.truncated };
  }

  say("Reading");
  const { readXlsx } = await import("./sheet");
  const x = await readXlsx(file);
  const c = clipText(x.text);
  return { ...base, kind: "sheet", text: c.text, truncated: c.truncated || x.truncated, pages: x.sheets };
}

async function keep(f: files.StoredFile): Promise<void> {
  if (!(await files.put(f))) {
    throw new Error("A copy of the file could not be kept in this browser — its storage may be full. Settings → Data says how full.");
  }
}
