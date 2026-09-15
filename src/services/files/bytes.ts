/* ============================================================================
 * bytes.ts — the conversions the file pipeline keeps needing.
 * ========================================================================== */

/** A blob's contents as base64, without the data-URL prefix. FileReader rather
 *  than a loop over the bytes: it is native, and a 20MB photo pushed through
 *  String.fromCharCode one byte at a time freezes the tab. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => {
      const s = String(rd.result || "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    rd.onerror = () => reject(rd.error || new Error("could not read the file"));
    rd.readAsDataURL(blob);
  });
}

export function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("This browser would not encode the picture."))), type, quality)
  );
}
