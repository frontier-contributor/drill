/* ============================================================================
 * srcdoc.ts — the page a canvas runs in.
 *
 * A canvas is HTML a model wrote, and it is run. Two walls hold, and both are
 * in the two exported constants here:
 *
 *   The sandbox is `allow-scripts` and nothing else. Without
 *   `allow-same-origin` the frame has an opaque origin: it cannot read this
 *   origin's localStorage — where the API key lives — or its IndexedDB,
 *   cookies or DOM, and it cannot navigate the page it sits in. **Never add
 *   allow-same-origin.** With it, the two walls become none.
 *
 *   The policy inside says `connect-src 'none'`, so nothing can be fetched and
 *   nothing can be sent. A canvas draws what it was written with; it cannot
 *   report that it ran, or post what is on the screen anywhere. That also
 *   means no CDN and no web fonts, which the prompt tells the model up front.
 *
 * The model's HTML is appended whole. A full document pasted in — doctype,
 * <html>, <head> — is handled by the parser the way browsers have always
 * handled stray structure tags: they are dropped and their contents kept, so
 * its styles and scripts still apply, and the policy above still comes first.
 *
 * Pure, and held to both rules by srcdoc.test.ts.
 * ========================================================================== */

/** The iframe's sandbox attribute. Read the header before changing it. */
export const CANVAS_SANDBOX = "allow-scripts";

export const CANVAS_CSP = [
  "default-src 'none'",
  /* A canvas is inline script by definition, and plenty of them build a
     function at runtime. Neither reaches anything outside the frame. */
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'"
].join("; ");

/** What the frame says to the page around it. Nothing else is listened to. */
export const CANVAS_MESSAGE = "drill-canvas";

export interface CanvasTheme {
  dark: boolean;
  ink: string;
  page: string;
  font: string;
}

/* Reports its height so the frame can be sized to its content, and forwards
   the errors a canvas throws — which is the whole of the bridge. It talks, it
   never listens: a message handler here would be a way in. */
function bridge(): string {
  return [
    "(function () {",
    "  var send = function (m) { try { parent.postMessage(m, '*'); } catch (e) {} };",
    "  var last = 0;",
    "  var report = function () {",
    "    var b = document.body;",
    "    if (!b) return;",
    /* The body, never document.documentElement: the root element's
       scrollHeight is at least the frame's own viewport, so a frame asked how
       tall it should be answers "as tall as I already am" and a canvas that
       shrinks — a second version with less in it, a panel that closed — keeps
       the taller frame for ever. The body is the content. */
    "    var h = Math.max(b.scrollHeight || 0, b.offsetHeight || 0, Math.ceil(b.getBoundingClientRect().bottom) || 0) + 2;",
    "    if (h < 3 || Math.abs(h - last) < 4) return;",
    "    last = h;",
    `    send({ source: '${CANVAS_MESSAGE}', type: 'height', height: h });`,
    "  };",
    "  var fail = function (message) {",
    `    send({ source: '${CANVAS_MESSAGE}', type: 'error', message: String(message).slice(0, 300) });`,
    "  };",
    "  window.addEventListener('error', function (e) { fail((e && e.message) || 'error'); });",
    "  window.addEventListener('unhandledrejection', function (e) {",
    "    fail((e && e.reason && e.reason.message) || (e && e.reason) || 'promise rejected');",
    "  });",
    "  window.addEventListener('load', function () {",
    "    report();",
    `    send({ source: '${CANVAS_MESSAGE}', type: 'ready' });`,
    "  });",
    /* An interval rather than requestAnimationFrame: a background tab runs
       neither often, but an interval does still run — and a canvas that grows
       after a click has to be able to say so. */
    "  setInterval(report, 400);",
    "})();"
  ].join("\n");
}

export function canvasDocument(html: string, theme: CanvasTheme): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`,
    "<style>",
    `:root { color-scheme: ${theme.dark ? "dark" : "light"}; }`,
    /* The padding is the body's alone. The frame is sized from the body's box,
       so anything the root element held would be measured as nothing. */
    `html { margin: 0; padding: 0; background: ${theme.page}; }`,
    `body { margin: 0; padding: 12px; background: ${theme.page}; color: ${theme.ink}; font-family: ${theme.font}; font-size: 14px; line-height: 1.5; }`,
    "* { box-sizing: border-box; }",
    "button, input, select { font: inherit; }",
    "</style>",
    `<script>${bridge()}</script>`,
    "</head>",
    "<body>",
    html,
    "</body>",
    "</html>"
  ].join("\n");
}
