/* ============================================================================
 * image.ts — a picture, made fit to send.
 *
 * Downscaled to the long edge every provider shrinks to on arrival anyway, so
 * nothing is uploaded only to be thrown away. Re-encoded, which drops a phone
 * photo's EXIF — its GPS position included — before it goes anywhere. A PNG
 * small enough to need no shrinking is left exactly as it came: that is a
 * screenshot, and JPEG smears the text in a screenshot.
 * ========================================================================== */
import { IMAGE_LONG_EDGE, MB, THUMB_EDGE } from "@/lib/files/limits";
import { canvasToBlob } from "./bytes";

export interface PreparedImage {
  blob: Blob;
  mime: string;
  w: number;
  h: number;
  /** A small JPEG data URL for the attachment card. */
  thumb: string;
}

export async function prepareImage(file: Blob, mime: string): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      mime === "image/heic"
        ? "This browser cannot open HEIC photos. Convert it to JPEG and attach it again."
        : "This picture could not be opened. Convert it to PNG or JPEG and attach it again."
    );
  }
  try {
    const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const png = mime === "image/png";
    const thumb = drawToCanvas(bitmap, fit(bitmap.width, bitmap.height, THUMB_EDGE), true).toDataURL("image/jpeg", 0.72);

    if (png && scale === 1 && file.size <= 5 * MB) return { blob: file, mime: "image/png", w, h, thumb };

    /* A PNG keeps its transparency. Anything else is flattened onto white,
       because JPEG has no alpha and a transparent pixel encodes as black. */
    const blob = await canvasToBlob(drawToCanvas(bitmap, { w, h }, !png), png ? "image/png" : "image/jpeg", 0.9);
    return { blob, mime: blob.type || (png ? "image/png" : "image/jpeg"), w, h, thumb };
  } finally {
    bitmap.close();
  }
}

export function fit(w: number, h: number, edge: number): { w: number; h: number } {
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

export function drawToCanvas(source: CanvasImageSource, to: { w: number; h: number }, opaque: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = to.w;
  canvas.height = to.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser would not draw the picture.");
  if (opaque) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, to.w, to.h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, to.w, to.h);
  return canvas;
}
