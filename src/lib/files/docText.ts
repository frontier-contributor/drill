/* ============================================================================
 * docText.ts — a Word document's structure, as text a model can read.
 *
 * mammoth turns a .docx into HTML; this turns that HTML into markdown-shaped
 * text. Not mammoth's own markdown output, which its author has deprecated, and
 * not raw text, which throws away exactly what makes a document readable: which
 * line is a heading, what is a list, and which cells of a table belong to the
 * same row.
 *
 * It works on a small tree rather than on the DOM, so it can be tested without
 * one. services/files/docx.ts walks the sanitised DOM into this shape — the
 * walk is the part that touches markup, and it never splices a string.
 * ========================================================================== */

export interface DocNode {
  /** Lower-case element name; absent for a text node. */
  tag?: string;
  text?: string;
  href?: string;
  children?: DocNode[];
}

const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside",
  "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "hr", "figure"
]);

function tagOf(n: DocNode): string {
  return (n.tag || "").toLowerCase();
}

export function docToText(nodes: DocNode[]): string {
  return blocks(nodes, 0)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function blocks(nodes: DocNode[], depth: number): string {
  let s = "";
  for (const n of nodes) s += block(n, depth);
  return s;
}

function block(n: DocNode, depth: number): string {
  const tag = tagOf(n);
  if (!tag) return inlineOf(n);
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) return `\n\n${"#".repeat(Number(heading[1]))} ${inline(n.children).trim()}\n\n`;
  if (tag === "ul" || tag === "ol") return `\n${list(n, depth, tag === "ol")}\n`;
  if (tag === "table") return `\n\n${table(n)}\n\n`;
  if (tag === "hr") return "\n\n---\n\n";
  if (tag === "br") return "\n";
  if (tag === "blockquote") {
    const inner = blocks(n.children || [], depth).trim();
    return `\n\n${inner
      .split("\n")
      .map((l) => "> " + l)
      .join("\n")}\n\n`;
  }
  if (BLOCK.has(tag)) {
    /* Word's HTML nests blocks inside blocks freely; a paragraph that holds a
       list is a container, not a line. */
    const kids = n.children || [];
    if (kids.some((k) => BLOCK.has(tagOf(k)) || tagOf(k) === "li")) return blocks(kids, depth);
    return `\n\n${inline(kids).trim()}\n\n`;
  }
  return inlineOf(n);
}

function inline(nodes: DocNode[] = []): string {
  return nodes.map(inlineOf).join("");
}

function inlineOf(n: DocNode): string {
  const tag = tagOf(n);
  if (!tag) return (n.text || "").replace(/\s+/g, " ");
  if (tag === "br") return "\n";
  if (tag === "img") return "[image]";
  if (tag === "a") {
    const label = inline(n.children).trim();
    return n.href && /^https?:\/\//i.test(n.href) && n.href !== label ? `${label} (${n.href})` : label;
  }
  if (BLOCK.has(tag) || tag === "li") return block(n, 0);
  return inline(n.children);
}

function list(n: DocNode, depth: number, ordered: boolean): string {
  const pad = "  ".repeat(depth);
  let i = 0;
  let s = "";
  for (const child of n.children || []) {
    const tag = tagOf(child);
    if (tag === "ul" || tag === "ol") {
      s += list(child, depth + 1, tag === "ol");
      continue;
    }
    if (tag !== "li") continue;
    i++;
    const kids = child.children || [];
    const nested = kids.filter((k) => tagOf(k) === "ul" || tagOf(k) === "ol");
    const own = kids.filter((k) => !nested.includes(k));
    s += `${pad}${ordered ? `${i}.` : "-"} ${inline(own).replace(/\s*\n\s*/g, " ").trim()}\n`;
    for (const k of nested) s += list(k, depth + 1, tagOf(k) === "ol");
  }
  return s;
}

function table(n: DocNode): string {
  const rows: string[][] = [];
  const walk = (x: DocNode) => {
    if (tagOf(x) === "tr") {
      rows.push(
        (x.children || [])
          .filter((c) => tagOf(c) === "td" || tagOf(c) === "th")
          .map((c) =>
            inline(c.children)
              .replace(/\s+/g, " ")
              .trim()
              .replace(/\|/g, "\\|")
          )
      );
      return;
    }
    for (const c of x.children || []) walk(c);
  };
  walk(n);
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => r[i] || "").join(" | ")} |`;
  return [line(rows[0]), `| ${Array(cols).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}
