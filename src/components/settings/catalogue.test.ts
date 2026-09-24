/* ============================================================================
 * catalogue.test.ts — the promises the settings table of contents makes.
 *
 * These exist because of a specific, repeated failure: a setting that is
 * editable, persisted, wired to something real, and *unreachable*. Backup and
 * restore sat in the review loop's Menu while the person who needed it looked
 * under Settings. Memory autonomy was the bottom half of the Chat page while
 * the memories themselves were in a sheet the review loop was the only view to
 * mount. The size of a run was read by two call sites and written by none.
 *
 * A test cannot know whether a control exists. What it can hold is the
 * structure that makes one findable: every page has content, every group of
 * settings belongs to a page that exists, and the words most likely to be
 * typed still land somewhere. Pure data, no DOM.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_META,
  GROUPS,
  SECTIONS,
  SECTION_IDS,
  search,
  sectionsOf,
  type CatId
} from "@/components/settings/catalogue";

const ALL: CatId[] = CATEGORY_META.map((c) => c.id);

test("every page has at least one group of settings on it", () => {
  /* A page with nothing under it is reachable from the rail, draws an empty
     panel, and cannot be searched for — the worst of the three states. */
  for (const c of CATEGORY_META) {
    assert.ok(sectionsOf(c.id).length > 0, `settings page "${c.id}" has no sections`);
  }
});

test("every group of settings names a page that exists", () => {
  for (const id of SECTION_IDS) {
    assert.ok(ALL.includes(SECTIONS[id].cat), `section "${id}" is filed under unknown page "${SECTIONS[id].cat}"`);
  }
});

test("every page sits in a group the rail actually renders", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const c of CATEGORY_META) {
    assert.ok(groups.has(c.group), `page "${c.id}" is in unknown rail group "${c.group}"`);
  }
});

test("page ids are unique", () => {
  assert.equal(new Set(ALL).size, ALL.length);
});

test("every group carries a heading and a sentence", () => {
  for (const id of SECTION_IDS) {
    const s = SECTIONS[id];
    assert.ok(s.title.trim(), `section "${id}" has no title`);
    assert.ok(s.sub.trim(), `section "${id}" has no blurb`);
    assert.ok(s.finds.length >= 3, `section "${id}" has too few search words to be findable`);
  }
});

/* The words below are the ones somebody actually types, and each one has a
   history. "backup" is the feature that was lost in a menu. "retention" and
   "new cards" were reachable only after guessing that scheduling lives under
   Review. "memory" and "transcript" were in the review loop's sheet. "mix"
   and "run" had no control at all before the migration. If one of these stops
   matching, a control has been renamed out of reach, not merely renamed. */
const MUST_FIND: [string, string][] = [
  ["backup", "data.backup"],
  ["restore", "data.backup"],
  ["api key", "connection.provider"],
  ["retention", "review.scheduling"],
  ["new cards", "review.scheduling"],
  ["mix", "review.queue"],
  ["deck", "review.queue"],
  ["delete deck", "project.decks"],
  ["run", "review.run"],
  ["transcript", "usage.transcript"],
  ["cost", "usage.cost"],
  ["autonomy", "memory.policy"],
  ["pin", "memory.store"],
  ["theme", "appearance.printing"],
  ["text size", "appearance.density"],
  ["follow-ups", "chat.requests"],
  ["read aloud", "listening.voice"],
  ["tts", "listening.voice"],
  ["speed", "listening.playback"],
  ["saved audio", "listening.audio"],
  ["voice mode", "voice.check"],
  ["microphone", "voice.check"],
  ["whisper", "voice.hearing"],
  ["language", "voice.hearing"],
  ["interrupt", "voice.turns"],
  ["temperature", "conversation.sampling"]
];

test("the words people type still reach the setting they name", () => {
  for (const [query, expected] of MUST_FIND) {
    const hits = search(query, ALL);
    assert.ok(hits.length > 0, `searching "${query}" finds nothing`);
    assert.ok(hits.includes(expected as never), `searching "${query}" does not reach ${expected} (found: ${hits.join(", ")})`);
  }
});

test("search is scoped to the pages the current view can render", () => {
  /* "This chat" is offered in chat and nowhere else. A result that opens a
     page this view cannot draw is a result that lands on an empty panel. */
  const withoutChat = ALL.filter((c) => c !== "conversation");
  assert.ok(search("temperature", ALL).length > 0);
  assert.equal(search("temperature", withoutChat).length, 0);
});

test("an empty query offers everything, and gibberish offers nothing", () => {
  assert.equal(search("", ALL).length, SECTION_IDS.length);
  assert.equal(search("qzxwv", ALL).length, 0);
});

test("every word of a multi-word query has to match", () => {
  /* Substring, all words required, deliberately not fuzzy: a search that
     guesses is a search you stop trusting the moment it guesses wrong. */
  assert.ok(search("longest interval", ALL).includes("review.scheduling" as never));
  assert.equal(search("longest banana", ALL).length, 0);
});

test("a page's name lists that page's contents, first and in order", () => {
  /* Typing a page name is how you browse rather than hunt, so the page's own
     words are part of every one of its sections' haystacks — and the page it
     names comes first. "review" also legitimately matches "review before it
     changes memory" and "review history"; those are true results and terrible
     first ones. */
  const hits = search("review", ALL);
  const own = sectionsOf("review");
  assert.deepEqual(hits.slice(0, own.length), own);
  assert.ok(hits.length > own.length, "expected the incidental matches to still be offered, below");
});
