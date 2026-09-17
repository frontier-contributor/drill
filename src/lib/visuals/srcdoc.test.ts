/* ============================================================================
 * srcdoc.test.ts — the two rules a canvas is safe under.
 *
 * Both fail silently if they are ever broken: a canvas with
 * `allow-same-origin` reads this origin's localStorage — the API key — and
 * still draws exactly the same picture, and a canvas that can reach the
 * network sends what is on the screen wherever it likes and still draws the
 * same picture. Nothing in the UI would look wrong. That is what this is for.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { CANVAS_CSP, CANVAS_SANDBOX, canvasDocument } from "@/lib/visuals/srcdoc";

const theme = { dark: true, ink: "#eee", page: "#222", font: "system-ui" };

test("the sandbox never grants same-origin", () => {
  assert.equal(CANVAS_SANDBOX, "allow-scripts");
  for (const forbidden of ["allow-same-origin", "allow-popups", "allow-top-navigation", "allow-forms", "allow-modals"]) {
    assert.ok(!CANVAS_SANDBOX.includes(forbidden), `sandbox must not grant ${forbidden}`);
  }
});

test("a canvas can reach nothing", () => {
  assert.match(CANVAS_CSP, /(^|;\s*)default-src 'none'/);
  assert.match(CANVAS_CSP, /connect-src 'none'/);
  assert.match(CANVAS_CSP, /form-action 'none'/);
  assert.match(CANVAS_CSP, /base-uri 'none'/);
  /* Pictures and sound may come from the canvas's own bytes and nowhere else. */
  assert.match(CANVAS_CSP, /img-src data: blob:/);
  assert.ok(!/https?:/.test(CANVAS_CSP), "no host may be allowed");
});

test("the policy is in the document, ahead of what the model wrote", () => {
  const doc = canvasDocument("<script>window.ran = true;</script><p>hello</p>", theme);
  const policyAt = doc.indexOf("Content-Security-Policy");
  assert.ok(policyAt > 0);
  assert.ok(policyAt < doc.indexOf("window.ran"), "the policy must come before the canvas");
  assert.ok(doc.includes("<p>hello</p>"));
});
