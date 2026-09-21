/* ============================================================================
 * parts.test.ts — what "no longer used by anything" has to mean.
 *
 * `referencedFileIds` feeds `unusedFileIds`, which feeds one button in
 * Settings → Data that deletes files. So a holder of a file id this function
 * forgets to walk is not a stale count or a slightly wrong number on a page:
 * it is the learner's picture, present and working, until the first time
 * anybody presses "Remove unused" — and then gone, with no error anywhere,
 * because from the sweep's point of view it did exactly what it was asked.
 *
 * A generated picture hangs off a *variant*, which is the holder that did not
 * exist when this function was written. That is what these pin.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { referencedFileIds } from "@/lib/files/parts";
import type { Attachment, Conversation, GeneratedImage, Turn } from "@/types/chat";

function picture(fileId: string): GeneratedImage {
  return { id: "g-" + fileId, fileId, mime: "image/png", w: 512, h: 512, size: 1000, createdAt: 1 };
}

function attachment(fileId: string, over: Partial<Attachment> = {}): Attachment {
  return { id: "a-" + fileId, name: fileId, kind: "image", size: 1, text: "", fileId, ...over };
}

function turn(over: Partial<Turn> = {}): Turn {
  return { id: "t", role: "assistant", variants: [], active: 0, createdAt: 1, ...over };
}

function conversation(turns: Turn[], pinned: Attachment[] = []): Pick<Conversation, "turns" | "pinnedAttachments"> {
  return { turns, pinnedAttachments: pinned };
}

test("a picture on a reply is in use", () => {
  const used = referencedFileIds([
    conversation([
      turn({
        variants: [{ content: "here it is", createdAt: 1, images: [picture("drawn-1")] }]
      })
    ])
  ]);
  assert.ok(used.has("drawn-1"), "a generated picture must not read as unused");
});

test("a picture on a variant you are not looking at is in use", () => {
  /* Regenerating pushes a second variant and moves `active` to it. The first
     one is one press of the arrow away and is still the learner's, so walking
     only the active variant would delete the picture behind the arrow. */
  const used = referencedFileIds([
    conversation([
      turn({
        active: 1,
        variants: [
          { content: "first go", createdAt: 1, images: [picture("drawn-old")] },
          { content: "second go", createdAt: 2, images: [picture("drawn-new")] }
        ]
      })
    ])
  ]);
  assert.ok(used.has("drawn-old"));
  assert.ok(used.has("drawn-new"));
});

test("attachments, pins and scanned pages are all still counted", () => {
  const used = referencedFileIds([
    conversation(
      [turn({ role: "user", attachments: [attachment("photo", { pageImages: ["scan-p1", "scan-p2"] })] })],
      [attachment("pinned")]
    )
  ]);
  assert.deepEqual([...used].sort(), ["photo", "pinned", "scan-p1", "scan-p2"]);
});

test("nothing held is nothing used", () => {
  /* The empty case has to be empty rather than defensive: if this ever
     returned "everything" on an empty database the sweep would never clean
     anything, which is the harmless failure — but it would also hide a real
     bug in the walk above. */
  assert.equal(referencedFileIds([]).size, 0);
  assert.equal(referencedFileIds([conversation([turn()])]).size, 0);
});
