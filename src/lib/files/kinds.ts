/* ============================================================================
 * kinds.ts — the kinds of file you can attach, declared once.
 *
 * The same bargain lib/visuals/catalogue.ts makes for figures and
 * lib/chatActions.ts makes for tools: one list, and everything else is read
 * off it — the row in the attach menu, the `accept` string the OS file dialog
 * is opened with, the size limit quoted before you pick, and which modality a
 * model needs before the row is offered at all.
 *
 * It replaces three hand-maintained `accept` strings that had drifted apart:
 * the composer offered about fifty extensions, the journal's capture box ten,
 * and project knowledge a different ten. None of the three was derived from
 * lib/files/sniff.ts, which is the only thing that actually decides, so all
 * three were a guess about what the app would accept — and the composer's was
 * the only one close to right.
 *
 * Two rules worth keeping:
 *
 *   **A kind here is advisory, never a gate.** `accept` is a hint to the file
 *   dialog; dragging a file onto the page and pasting one both bypass it
 *   entirely. services/files/ingest.ts reads the bytes and is the only thing
 *   that decides, and it refuses with a sentence. A menu that offered what
 *   ingest refuses would be the bug; a menu that is merely narrower is fine.
 *
 *   **`needs` is a modality, not a model name.** Whether a row is live is
 *   lib/modality.ts's three-state verdict, and `unknown` leaves it live — a
 *   local model has no catalogue entry, and greying the picture row out for
 *   every Ollama user would be a worse lie than sending a picture that gets
 *   ignored.
 *
 * Pure.
 * ========================================================================== */
import type { Modality } from "@/lib/modality";
import { TEXT_EXTENSIONS, type FileKind } from "./sniff";
import { LIMITS, size } from "./limits";

/** The rows of the attach menu, in the order they are offered. */
export type AttachKindId = Exclude<FileKind, "unsupported"> | "any";

export interface AttachKind {
  id: AttachKindId;
  /** The row's title. What you would call the thing, not its format. */
  label: string;
  /** The row's second line, when the kind is available. */
  blurb: string;
  /** Extensions and MIME patterns for the file dialog, comma-joined. */
  accept: string;
  /**
   * What the model must be able to take for this row to be live. Undefined
   * means "anything can read it", which is true of everything but a picture:
   * a PDF, a Word file and a spreadsheet are read in this browser and reach
   * the model as text it can quote, on every backend.
   */
  needs?: Modality;
}

const dotted = (exts: string[]) => exts.map((e) => "." + e);

export const ATTACH_KINDS: AttachKind[] = [
  {
    id: "image",
    label: "Photo or screenshot",
    blurb: "Sent to the model as a picture. Shrunk here first, and its location data is stripped.",
    accept: "image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.heic,.heif,.avif",
    needs: "image"
  },
  {
    id: "pdf",
    label: "PDF",
    blurb: "Read in this browser, page by page, so the model gets text it can quote.",
    accept: ".pdf,application/pdf"
  },
  {
    id: "doc",
    label: "Word document",
    blurb: "Headings and tables kept. The old .doc format is not read — save it as .docx.",
    accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  },
  {
    id: "sheet",
    label: "Spreadsheet or CSV",
    blurb: "Every sheet described as a table, up to five hundred rows each.",
    accept: ".xlsx,.xlsm,.csv,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  },
  {
    id: "text",
    label: "Text or code",
    blurb: "Markdown, LaTeX, JSON, and source in about sixty languages.",
    accept: [...dotted(TEXT_EXTENSIONS), "text/*"].join(",")
  },
  {
    /* The escape hatch, and the behaviour the paperclip had before this menu
       existed. Some things are named in ways no list predicts — a Makefile, a
       .env, a dotfile — and ingest reads the bytes anyway. */
    id: "any",
    label: "Any file",
    blurb: "Anything at all. What it really is gets worked out from its bytes.",
    accept: ""
  }
];

export function attachKind(id: AttachKindId): AttachKind {
  return ATTACH_KINDS.find((k) => k.id === id) || ATTACH_KINDS[ATTACH_KINDS.length - 1];
}

/** The `accept` for a set of kinds — what a surface that takes several opens
 *  its file dialog with. Empty when "any" is among them, which is how an
 *  unfiltered dialog is spelled. */
export function acceptFor(ids: readonly AttachKindId[]): string {
  if (ids.includes("any")) return "";
  return ids
    .map((id) => attachKind(id).accept)
    .filter(Boolean)
    .join(",");
}

/** "up to 20 MB" — the row's quiet third line, so a refusal is not the first
 *  time anyone hears the number. */
export function limitOf(id: AttachKindId): string {
  if (id === "any") return "";
  return "up to " + size(LIMITS[id]);
}

/**
 * The kinds a surface that only keeps text will take.
 *
 * Project knowledge and the journal hold text, not bytes — `ingest` refuses a
 * picture there with its own sentence — so those two open their file dialog
 * on everything except pictures rather than on a list they maintain by hand.
 */
export const TEXT_ONLY_KINDS: AttachKindId[] = ["pdf", "doc", "sheet", "text"];
