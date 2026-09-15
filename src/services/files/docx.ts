/* ============================================================================
 * docx.ts — a Word document, as structured text.
 *
 * mammoth reads the .docx into HTML. mammoth does no sanitising of its own,
 * and this HTML came out of a document somebody sent you, so it goes through
 * DOMPurify and then a walk over nodes into lib/files/docText's tree — never
 * into the page, and never spliced as a string.
 *
 * Embedded pictures are dropped rather than inlined: mammoth's default turns
 * each into a base64 data URI, and a document with a few screenshots in it
 * would become megabytes of text the model cannot use.
 * ========================================================================== */
import { docToText, type DocNode } from "@/lib/files/docText";

export async function readDocx(file: Blob): Promise<string> {
  const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([import("mammoth"), import("dompurify")]);
  let html: string;
  try {
    const out = await mammoth.convertToHtml(
      { arrayBuffer: await file.arrayBuffer() },
      { convertImage: mammoth.images.imgElement(async () => ({ src: "" })), externalFileAccess: false }
    );
    html = out.value;
  } catch (e) {
    throw new Error(`This Word file could not be read — it may be damaged, or not really a .docx. (${(e as Error)?.message || "unknown error"})`);
  }
  const frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) as unknown as DocumentFragment;
  return docToText(Array.from(frag.childNodes).map(toDocNode));
}

function toDocNode(node: Node): DocNode {
  if (node.nodeType === Node.TEXT_NODE) return { text: node.nodeValue || "" };
  if (node.nodeType !== Node.ELEMENT_NODE) return { text: "" };
  const el = node as Element;
  return {
    tag: el.tagName.toLowerCase(),
    href: el.getAttribute("href") || undefined,
    children: Array.from(el.childNodes).map(toDocNode)
  };
}
