/* ============================================================================
 * markdown.ts - model output -> safe HTML.
 *
 * Order matters and is not obvious:
 *   1. pull maths out into placeholders BEFORE markdown runs, because
 *      \frac{a}{b} and _i_ are both valid markdown emphasis and KaTeX will
 *      never see them otherwise
 *   2. markdown -> HTML
 *   3. sanitise
 *   4. put rendered KaTeX back, walking the DOM (see restoreMath)
 *
 * Everything here is defensive: this renders text a language model produced,
 * which is text an attacker could have influenced through a pasted document.
 * ========================================================================== */
import { marked } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import hljs from "highlight.js/lib/core";
import { visualForFence, type VisualBlock, type VisualKind } from "@/lib/visuals/catalogue";

import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdownLang from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import yaml from "highlight.js/lib/languages/yaml";
import r from "highlight.js/lib/languages/r";

const LANGS: Record<string, unknown> = {
  javascript, typescript, python, bash, json, css, xml, markdown: markdownLang,
  sql, rust, go, java, cpp, c, yaml, r
};
for (const [name, def] of Object.entries(LANGS)) {
  hljs.registerLanguage(name, def as never);
}
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["html"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["c++"], { languageName: "cpp" });

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/* ---------------------------------------------------------------- maths -- */

interface MathHit {
  html: string;
  /** the original source, restored verbatim wherever rendering would be
   *  wrong - inside a code block, or inside an attribute value */
  raw: string;
  /** the TeX alone, without its delimiters - kept on the rendered root for
   *  reading aloud (see restoreMath) */
  tex: string;
}

/* U+2063 (invisible separator) delimits placeholders. It survives marked
 * untouched (only & < > " ' are escaped), cannot appear in real prose, and
 * needs no regex escaping. */
const SEP = "⁣";
const TOKEN_RE = /⁣M(\d+)⁣/g;

/** Swap maths for inert placeholders, rendering each with KaTeX. Fenced and
 *  inline code are masked first so a `$5` in a shell snippet, or a regex full
 *  of dollars, is never treated as maths. */
function extractMath(src: string): { text: string; hits: MathHit[] } {
  const hits: MathHit[] = [];
  const codeBlocks: string[] = [];

  let text = src.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    codeBlocks.push(m);
    return ` CODE${codeBlocks.length - 1} `;
  });

  const render = (tex: string, display: boolean): string => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: false, output: "html" });
    } catch {
      // A malformed expression shows as its literal source rather than taking
      // the whole message down.
      return `<code>${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
    }
  };

  const push = (raw: string, html: string, tex: string): string => {
    const token = `${SEP}M${hits.length}${SEP}`;
    hits.push({ html, raw, tex });
    return token;
  };

  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex: string) => push(m, render(tex.trim(), true), tex.trim()));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex: string) => push(m, render(tex.trim(), true), tex.trim()));
  text = text.replace(/(?<!\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g, (m, tex: string) => push(m, render(tex.trim(), false), tex.trim()));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex: string) => push(m, render(tex.trim(), false), tex.trim()));

  text = text.replace(/ CODE(\d+) /g, (_m, i: string) => codeBlocks[Number(i)]);
  return { text, hits };
}

/**
 * Put the rendered maths back, working over the parsed DOM rather than the
 * HTML string.
 *
 * A string replace cannot tell a token sitting in prose from one that landed
 * inside <code> or inside an attribute, and splicing markup into an attribute
 * value breaks out of it. Malformed markdown - an unclosed fence, a fence not
 * at line start - puts tokens in exactly those places, so this walks real
 * nodes and decides per location: render in prose, restore the literal source
 * everywhere else.
 */
function restoreMath(html: string, hits: MathHit[]): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const at = (i: number): MathHit | undefined => hits[i];

  // attribute values are never markup - always the original source
  for (const el of Array.from(tpl.content.querySelectorAll<HTMLElement>("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.value.includes(SEP)) continue;
      el.setAttribute(attr.name, attr.value.replace(TOKEN_RE, (m, i: string) => at(Number(i))?.raw ?? m));
    }
  }

  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeValue?.includes(SEP)) targets.push(node as Text);
  }

  for (const text of targets) {
    const value = text.nodeValue || "";

    if (text.parentElement?.closest("code, pre")) {
      text.nodeValue = value.replace(TOKEN_RE, (m, i: string) => at(Number(i))?.raw ?? m);
      continue;
    }

    const frag = document.createDocumentFragment();
    let last = 0;
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(value))) {
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)));
      const hit = at(Number(m[1]));
      if (hit) {
        // KaTeX output is generated here, not model text, and its tags are on
        // the sanitiser allowlist below.
        const holder = document.createElement("span");
        holder.innerHTML = hit.html;
        /* The source rides along on the rendered root, for reading aloud:
           KaTeX's HTML output keeps no copy of the TeX, and a voice handed
           the rendered glyphs says "x two". Set through the DOM like
           everything else here, never spliced into the markup. */
        holder.firstElementChild?.setAttribute("data-tex", hit.tex);
        while (holder.firstChild) frag.appendChild(holder.firstChild);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
    text.parentNode?.replaceChild(frag, text);
  }

  return tpl.innerHTML;
}

/* ------------------------------------------------------------- renderer -- */

/* Set for the length of one renderReply() call: which kinds of figure to draw,
   and the blocks found so far. A module-level collector is exact here because
   marked's renderer is a module-level singleton and parse() is synchronous. */
let drawing: { kinds: Set<VisualKind>; found: VisualBlock[] } | null = null;

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }: { text: string; lang?: string }): string {
  const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();

  /* A figure, when this kind is switched on. The block is set aside and an
     empty slot left in its place for MessageTurn to draw into — only an index
     goes into the markup, so nothing a model wrote is ever parsed as HTML. */
  if (drawing) {
    const def = visualForFence(language);
    if (def && drawing.kinds.has(def.kind)) {
      const at = drawing.found.push({ kind: def.kind, lang: language, source: text }) - 1;
      return `<div class="vis-slot" data-vis="${at}"></div>`;
    }
  }

  let body: string;
  let shown = language;
  if (language && hljs.getLanguage(language)) {
    body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } else {
    const auto = hljs.highlightAuto(text);
    body = auto.value;
    shown = language || auto.language || "";
  }
  // data-code carries the raw source so the copy button never has to scrape
  // the highlighted DOM back into text.
  return (
    `<div class="codeblock" data-code="${escapeHtml(text)}">` +
    `<div class="codehead"><span class="codelang">${escapeHtml(shown || "text")}</span>` +
    `<button class="codecopy" type="button" data-copy>Copy</button></div>` +
    `<pre><code class="hljs language-${escapeHtml(shown)}">${body}</code></pre></div>`
  );
};

renderer.link = function ({ href, title, tokens }): string {
  const text = this.parser.parseInline(tokens);
  const safe = /^https?:\/\//i.test(href || "") ? href : "";
  if (!safe) return text;
  return `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener"${
    title ? ` title="${escapeHtml(title)}"` : ""
  }>${text}</a>`;
};

marked.use({ renderer });

/* KaTeX emits a lot of structural markup; DOMPurify's default list drops it. */
const PURIFY_CONFIG = {
  ADD_TAGS: [
    "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "ms", "mtext", "msup", "msub",
    "msubsup", "mfrac", "msqrt", "mroot", "mstyle", "munder", "mover", "munderover", "mtable",
    "mtr", "mtd", "mspace", "mpadded", "mphantom", "menclose", "svg", "path", "line", "g"
  ],
  ADD_ATTR: [
    "aria-hidden", "data-copy", "data-code", "style", "class", "target", "rel",
    "xmlns", "viewBox", "preserveAspectRatio", "d", "x1", "x2", "y1", "y2",
    "width", "height", "stroke-width", "encoding", "displaystyle", "scriptlevel", "mathvariant"
  ],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "textarea", "style", "link", "meta"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "formaction", "srcdoc"]
} satisfies Parameters<typeof DOMPurify.sanitize>[1];

/** Render model markdown to sanitised HTML with code highlighting and maths. */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const { text, hits } = extractMath(src);
  const html = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
  return hits.length ? restoreMath(clean, hits) : clean;
}

/**
 * Render a reply, drawing the figures in it.
 *
 * The HTML comes back with an empty slot where each figure goes, and the
 * blocks beside it rather than inside it. `renderMarkdown` is unchanged for
 * every other caller: there, a fenced block is a code block.
 */
export function renderReply(src: string, kinds: readonly VisualKind[]): { html: string; visuals: VisualBlock[] } {
  if (!src) return { html: "", visuals: [] };
  drawing = { kinds: new Set(kinds), found: [] };
  try {
    return { html: renderMarkdown(src), visuals: drawing.found };
  } finally {
    drawing = null;
  }
}

/** Re-exported so chat components have one markdown import. Defined in
 *  plaintext.ts so modules that only need stripping (the conversation store,
 *  sidebar previews) do not pull this file's dependencies with them. */
export { markdownToText } from "./plaintext";
