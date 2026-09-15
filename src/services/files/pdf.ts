/* ============================================================================
 * pdf.ts — a PDF, read in this browser with pdf.js.
 *
 * Local first, on purpose. It is free, it is private, and it works identically
 * on every backend including Ollama — which is the only way "attach a paper"
 * can be a feature of this app rather than of one provider. The text is what
 * the model reads, page by page with the page numbers kept, so an answer can
 * say where something came from.
 *
 * A page with no text layer is a scan. Those pages are rendered as pictures
 * (a few at most) for a model that can see; OpenRouter's parsers are the
 * other road for them, chosen in Settings → Chat.
 *
 * pdf.js is loaded on first use and never by the review loop. The version in
 * package.json is past the fix for CVE-2024-4367 (arbitrary JavaScript from a
 * crafted font), which is the one that matters for reading PDFs someone sent.
 * ========================================================================== */
import { IMAGE_LONG_EDGE, MAX_PAGE_IMAGES, MAX_PDF_PAGES, THUMB_EDGE } from "@/lib/files/limits";
import { canvasToBlob } from "./bytes";

type PdfLib = typeof import("pdfjs-dist");
type PdfDoc = Awaited<ReturnType<PdfLib["getDocument"]>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDoc["getPage"]>>;

export interface PdfRead {
  text: string;
  /** Pages in the file. */
  pages: number;
  /** Pages actually read, which is fewer for a very long file. */
  readPages: number;
  scanned: number[];
  thumb?: string;
  /** The scanned pages as JPEGs, in the order of `scanned`. */
  pageImages: Blob[];
}

let loading: Promise<PdfLib> | null = null;

function loadPdfjs(): Promise<PdfLib> {
  if (!loading) {
    const p = Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
    loading = p;
    p.catch(() => {
      if (loading === p) loading = null;
    });
  }
  return loading;
}

function aborted(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export async function readPdf(
  file: Blob,
  opts: { signal?: AbortSignal; renderScans: boolean; onProgress?: (done: number, total: number) => void }
): Promise<PdfRead> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const onAbort = () => void task.destroy();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let doc: PdfDoc;
  try {
    doc = await task.promise;
  } catch (e) {
    opts.signal?.removeEventListener("abort", onAbort);
    if (opts.signal?.aborted) throw aborted();
    if ((e as { name?: string })?.name === "PasswordException") {
      throw new Error("This PDF is password-protected. Remove the password and attach it again.");
    }
    throw new Error(`This PDF could not be read — it may be damaged. (${(e as Error)?.message || "unknown error"})`);
  }

  try {
    const total = Math.min(doc.numPages, MAX_PDF_PAGES);
    const texts: string[] = [];
    const scanned: number[] = [];
    const pageImages: Blob[] = [];
    let thumb: string | undefined;

    for (let n = 1; n <= total; n++) {
      if (opts.signal?.aborted) throw aborted();
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items as unknown[]);
      /* Twenty characters is below a page number and a running head, which a
         scan's OCR-less page sometimes still carries. */
      const isScan = text.replace(/\s/g, "").length < 20;
      if (isScan) scanned.push(n);
      texts.push(`[page ${n}]\n${text}`);

      if (n === 1) thumb = (await render(page, THUMB_EDGE)).toDataURL("image/jpeg", 0.72);
      if (isScan && opts.renderScans && pageImages.length < MAX_PAGE_IMAGES) {
        pageImages.push(await canvasToBlob(await render(page, IMAGE_LONG_EDGE), "image/jpeg", 0.85));
      }
      page.cleanup();
      opts.onProgress?.(n, total);
    }

    const rest = doc.numPages - total;
    return {
      text: texts.join("\n\n") + (rest > 0 ? `\n\n[… ${rest} more pages were not read]` : ""),
      pages: doc.numPages,
      readPages: total,
      scanned,
      thumb,
      pageImages
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    /* The loading task owns the worker-side document; destroying it is what
       releases the file's memory in pdf.js 6. */
    void task.destroy();
  }
}

/**
 * A page's text items as lines. pdf.js hands back runs of text with positions,
 * not words with spaces: two runs on one line with a gap between them are two
 * words, and a run that starts lower down is a new line even when the file did
 * not say so.
 */
function pageText(items: unknown[]): string {
  let out = "";
  let lastEnd = 0;
  let lastY: number | null = null;
  for (const raw of items) {
    const it = raw as { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
    if (typeof it.str !== "string") continue;
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const x = t[4];
    const y = t[5];
    const fontSize = Math.hypot(t[2], t[3]) || it.height || 10;
    if (lastY !== null && out && !out.endsWith("\n")) {
      if (Math.abs(y - lastY) > fontSize * 0.5) out += "\n";
      else if (x - lastEnd > fontSize * 0.15 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += " ";
    }
    out += it.str;
    if (it.hasEOL) out += "\n";
    lastEnd = x + (it.width || 0);
    lastY = y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function render(page: PdfPage, longEdge: number): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: longEdge / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  /* The print intent, because the display intent paces itself on
     requestAnimationFrame — which does not run in a background tab, so a PDF
     attached just before switching away would sit at "page 1" until you came
     back. Nothing about a thumbnail needs the display intent. */
  await page.render({ canvas, viewport, intent: "print" }).promise;
  return canvas;
}
