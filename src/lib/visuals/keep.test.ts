/* ============================================================================
 * keep.test.ts — what keeping a figure must never do.
 *
 * Both failures this guards are silent. A key that is too loose quietly files
 * the second diagram you kept as a *revision* of the first, so the shelf shows
 * one where there should be two and the one you were looking for is hidden
 * behind a version arrow you have no reason to press. A fold that overwrites
 * loses the earlier source outright — the same class of loss the save alarm
 * exists for, except nothing would report it, because from every seat in the
 * UI it looks exactly like a successful keep.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { allVersions, defaultTitle, figureKey, foldKeep, type KeptFigure } from "@/lib/visuals/keep";
import type { VisualBlock } from "@/lib/visuals/catalogue";

let n = 0;
const ids = () => "id" + ++n;

function block(over: Partial<VisualBlock> = {}): Pick<VisualBlock, "kind" | "source" | "info"> {
  return { kind: "diagram", info: "mermaid", source: "flowchart TD\n A-->B", ...over };
}

const where = { projectId: "p1", conversationId: "c1" };

test("two plain flowcharts are two figures, not two versions of one", () => {
  /* Both derive the title "flowchart" — mermaidTitle returns the first word
     when there is no front matter — so a title-shaped key would have made the
     second keep look like a revision of the first and buried it. */
  const a = block({ source: "flowchart TD\n A-->B" });
  const b = block({ source: "flowchart TD\n X-->Y" });
  assert.equal(defaultTitle(a), defaultTitle(b));
  assert.notEqual(figureKey(a, where), figureKey(b, where));
});

test("keeping the same block twice writes nothing", () => {
  const first = foldKeep(undefined, { block: block(), ...where }, 1000, ids);
  assert.equal(first.status, "kept");
  const again = foldKeep(first.figure, { block: block(), ...where }, 2000, ids);
  assert.equal(again.status, "already");
  assert.equal(again.figure, first.figure);
});

test("a trailing newline is not a different figure", () => {
  /* The two readers of a fence disagree about its last newline: marked hands
     the block over without it, the scan over the transcript keeps it. */
  const first = foldKeep(undefined, { block: block(), ...where }, 1000, ids);
  const again = foldKeep(first.figure, { block: block({ source: "flowchart TD\n A-->B\n" }), ...where }, 2000, ids);
  assert.equal(again.status, "already");
});

test("a canvas rewritten under the same title revises, and keeps the old source", () => {
  const v1 = block({ kind: "canvas", info: 'drill-canvas title="Gradient descent"', source: "<h1>one</h1>" });
  const v2 = block({ kind: "canvas", info: 'drill-canvas title="Gradient descent"', source: "<h1>two</h1>" });
  assert.equal(figureKey(v1, where), figureKey(v2, where));

  const kept = foldKeep(undefined, { block: v1, ...where }, 1000, ids).figure;
  const revised = foldKeep(kept, { block: v2, ...where }, 2000, ids);

  assert.equal(revised.status, "revised");
  assert.equal(revised.figure.source, "<h1>two</h1>");
  assert.deepEqual(
    allVersions(revised.figure).map((v) => v.source),
    ["<h1>one</h1>", "<h1>two</h1>"]
  );
  assert.equal(revised.figure.created, 1000);
  assert.equal(revised.figure.updated, 2000);
});

test("stepping back to an older version and keeping it again changes nothing", () => {
  const v1 = block({ kind: "canvas", info: 'drill-canvas title="Gradient descent"', source: "<h1>one</h1>" });
  const v2 = block({ kind: "canvas", info: 'drill-canvas title="Gradient descent"', source: "<h1>two</h1>" });
  const kept = foldKeep(undefined, { block: v1, ...where }, 1000, ids).figure;
  const revised = foldKeep(kept, { block: v2, ...where }, 2000, ids).figure;

  const back = foldKeep(revised, { block: v1, ...where }, 3000, ids);
  assert.equal(back.status, "already");
  assert.equal(back.figure.source, "<h1>two</h1>");
  assert.equal(back.figure.versions.length, 1);
});

test("the same canvas title in a second thread is a second figure", () => {
  /* Versions are a thread's idea of a canvas. Two conversations that both
     produced a canvas called "Canvas" — which is the fallback title — are not
     revisions of each other. */
  const c = block({ kind: "canvas", info: "drill-canvas", source: "<h1>a</h1>" });
  assert.notEqual(figureKey(c, where), figureKey(c, { projectId: "p1", conversationId: "c2" }));
});

test("renaming does not change what the next revision folds into", () => {
  const v1 = block({ kind: "canvas", info: 'drill-canvas title="Softmax"', source: "<h1>one</h1>" });
  const v2 = block({ kind: "canvas", info: 'drill-canvas title="Softmax"', source: "<h1>two</h1>" });
  const kept = foldKeep(undefined, { block: v1, ...where }, 1000, ids).figure;
  const renamed: KeptFigure = { ...kept, title: "The one that finally made sense" };

  const revised = foldKeep(renamed, { block: v2, ...where }, 2000, ids);
  assert.equal(revised.status, "revised");
  /* And the model's title does not take yours back off the shelf. */
  assert.equal(revised.figure.title, "The one that finally made sense");
});

test("a chart keeps the title from its own spec", () => {
  const chart = block({ kind: "chart", info: "vega-lite", source: '{"title":"Loss by epoch","mark":"line"}' });
  assert.equal(defaultTitle(chart), "Loss by epoch");
});
