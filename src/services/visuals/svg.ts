/* ============================================================================
 * svg.ts — an SVG a model wrote, or Mermaid drew, made inert and given a size.
 *
 * Two walls, not one. DOMPurify's SVG profile strips scripts, event handlers
 * and anything that is not drawing; and the result is never put into the page
 * at all, but shown through an <img> from a blob. An SVG loaded as an image
 * runs no script, loads no external resource and cannot style anything outside
 * itself, so even a sanitiser miss draws a picture and nothing more. That is
 * also why Mermaid's own <style> element is allowed through here — inside an
 * image it can only restyle the image.
 * ========================================================================== */
import DOMPurify from "dompurify";

const SVG_NS = "http://www.w3.org/2000/svg";

export function safeSvg(raw: string): string {
  const frag = DOMPurify.sanitize(String(raw || ""), {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["foreignObject", "script", "a"],
    RETURN_DOM_FRAGMENT: true
  }) as unknown as DocumentFragment;
  const svg = frag.querySelector("svg");
  if (!svg) throw new Error("there is no <svg> element in it");

  svg.setAttribute("xmlns", SVG_NS);
  /* An image needs an intrinsic size. Mermaid writes width="100%" and a
     max-width style for inline use; the viewBox has the real size. */
  const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    const w = svg.getAttribute("width");
    const h = svg.getAttribute("height");
    if (!w || w.includes("%")) svg.setAttribute("width", String(Math.ceil(box[2])));
    if (!h || h.includes("%")) svg.setAttribute("height", String(Math.ceil(box[3])));
  }
  svg.style.removeProperty("max-width");
  return new XMLSerializer().serializeToString(svg);
}

/** Draw an SVG at twice its size into a PNG, for saving. */
export function svgToPng(svgText: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((img.naturalWidth || 800) * scale));
        canvas.height = Math.max(1, Math.round((img.naturalHeight || 600) * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This browser would not draw the picture.");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("This browser would not encode the picture."))), "image/png");
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The drawing could not be turned into a PNG."));
    };
    img.src = url;
  });
}
