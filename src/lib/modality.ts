/* ============================================================================
 * modality.ts — can this model see a picture, or read a file itself?
 *
 * The same question lib/thinking.ts answers about reasoning, and answered the
 * same way, for the same reason: one OpenRouter key reaches models that see and
 * models that do not, and the model chip is one click from the paperclip. The
 * catalogue's `architecture.input_modalities` is the lookup (services/pricing.ts
 * already has it in hand).
 *
 * Three answers, and the third is the one that matters:
 *
 *   yes      the catalogue lists the modality. Sent as itself.
 *   no       the catalogue lists the model and not the modality. The picture
 *            is not sent — its name is, and the card says so before you press
 *            Send rather than after the reply ignores it.
 *   unknown  a local model, a Groq id, or a catalogue not loaded yet. Sent: the
 *            backend refuses clearly if it cannot, which is a better teacher
 *            than a warning on every picture shown to every Ollama user.
 *
 * Pure — the caller passes the catalogue entry's modalities in.
 * ========================================================================== */
import type { PdfEngine } from "@/types";

export type ModalityVerdict = "yes" | "no" | "unknown";
export type Modality = "image" | "file";

export function canTake(modalities: string[] | undefined, want: Modality): ModalityVerdict {
  if (!Array.isArray(modalities) || modalities.length === 0) return "unknown";
  return modalities.includes(want) ? "yes" : "no";
}

/**
 * Whether this model can hand back a picture rather than only read one.
 *
 * The mirror of `canTake`, over `architecture.output_modalities`, and the
 * three states mean the same things — except that the `unknown` bargain lands
 * differently here and it is worth being explicit about why.
 *
 * For input, `unknown` sends the picture and lets the backend refuse, because
 * refusing costs one clear error and greying the control out costs every local
 * model for ever. For output, `unknown` leaves the switch *live* for the same
 * reason, but a model that ignores it simply answers in words: asking a
 * text-only model for a picture is not an error, it is a disappointment. So
 * the control says it is a guess rather than promising.
 */
export function canMake(modalities: string[] | undefined, want: Modality): ModalityVerdict {
  if (!Array.isArray(modalities) || modalities.length === 0) return "unknown";
  return modalities.includes(want) ? "yes" : "no";
}

/** What the Image switch says about this model, in words. */
export function imageOutputWhy(model: string, verdict: ModalityVerdict): string {
  if (verdict === "yes") return "Ask for a picture and this model will draw one.";
  if (verdict === "no") return `${shortName(model)} writes text only. Pick an image model to draw with.`;
  return `Not known whether ${shortName(model)} can draw. Left on — if it cannot, it will answer in words.`;
}

function shortName(model: string): string {
  return model.split("/").pop() || model || "This model";
}

/** Said on an image's card, before sending. Null when there is nothing to say. */
export function imageWarning(model: string, verdict: ModalityVerdict): string | null {
  if (verdict !== "no") return null;
  return `${shortName(model)} cannot see images, so only the file name will be sent. Pick a vision model to send the picture.`;
}

/** Said on a PDF's card when some of it is scanned and nothing on this route
 *  can read a scan. */
export function scannedWarning(
  model: string,
  image: ModalityVerdict,
  scannedPages: number,
  engine: PdfEngine,
  backend: string
): string | null {
  if (!scannedPages) return null;
  if (engine !== "local" && backend === "openrouter") return null;
  if (image !== "no") return null;
  return (
    `${scannedPages} page${scannedPages === 1 ? " is a scan" : "s are scans"} with no text in ${scannedPages === 1 ? "it" : "them"}, ` +
    `and ${shortName(model)} cannot see images — ${scannedPages === 1 ? "it" : "those pages"} will not be read.`
  );
}

/** Whether a PDF engine applies to this route, and what happens instead when
 *  it does not. `local` always applies; the rest are OpenRouter's. */
export function pdfEngineUsable(engine: PdfEngine, backend: string, file: ModalityVerdict): { ok: boolean; why: string } {
  if (engine === "local") return { ok: true, why: "Read in this browser. Free, private, and the same on every backend." };
  if (backend !== "openrouter") {
    return { ok: false, why: "Only OpenRouter parses PDFs on its side; on this backend they are read in the browser instead." };
  }
  if (engine === "native" && file === "no") {
    return { ok: false, why: "This model cannot read PDF files itself, so the text is extracted in the browser instead." };
  }
  return { ok: true, why: "" };
}
