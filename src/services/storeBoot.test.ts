/* ============================================================================
 * storeBoot.test.ts — a database that cannot be read is never written over.
 *
 * store.init() used to treat an unparseable database exactly like an absent
 * one: it built a fresh database and saved it, over the original, before the
 * learner had seen anything. Whatever had damaged the bytes, the damage was
 * then permanent, and it happened silently — the app opened on a starter deck
 * looking perfectly healthy. A readable v2 key underneath was worse: it won
 * the fall-through, so months of newer history were replaced with older.
 *
 * Nothing on screen would ever say this had happened, which is the reason for
 * a test rather than a browser check.
 * ========================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import * as store from "@/services/store";
import { redactKeys, STORAGE_KEY } from "@/services/storage";

/** The throw happens in loadRaw, before init() reaches anything that needs a
 *  window, so a Map-backed localStorage is all this needs. */
function fakeStorage(seed: Record<string, string>) {
  const m = new Map(Object.entries(seed));
  const ls = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    }
  };
  (globalThis as unknown as { localStorage: typeof ls }).localStorage = ls;
  return m;
}

test("an unparseable database stops the boot and is left byte for byte", () => {
  const damaged = '{"v":4,"decks":{"d1":{"cards":[{"q":"what is a gradient';
  const m = fakeStorage({ [STORAGE_KEY]: damaged });
  assert.throws(() => store.init(), store.UnreadableDatabaseError);
  assert.equal(m.get(STORAGE_KEY), damaged, "nothing may be written over it");
  /* Belt and braces: a save attempted after a refused boot must not write
     "null" over the bytes either. */
  store.saveNow();
  assert.equal(m.get(STORAGE_KEY), damaged);
});

test("an older v2 database does not win over a damaged newer one", () => {
  const damaged = "{not json";
  const v2 = JSON.stringify({ active: "a", decks: { a: { name: "old", cards: [{ q: "q", a: "a" }], srs: {}, log: [] } } });
  const m = fakeStorage({ [STORAGE_KEY]: damaged, "mldrill:v2": v2 });
  assert.throws(() => store.init(), store.UnreadableDatabaseError);
  assert.equal(m.get(STORAGE_KEY), damaged);
});

test("JSON that is not shaped like a database is refused, not replaced", () => {
  const m = fakeStorage({ [STORAGE_KEY]: "[1,2,3]" });
  assert.throws(() => store.init(), store.UnreadableDatabaseError);
  assert.equal(m.get(STORAGE_KEY), "[1,2,3]");
});

test("the rescue download carries no key, however it is quoted", () => {
  const raw =
    '{"settings":{"key":"sk-or-v1-abc","creds":{"groq":{"key":"gsk_\\"x\\"y","model":"m"}},"theme":"night"},"decks":{}}';
  const out = redactKeys(raw);
  assert.ok(!out.includes("sk-or-v1-abc"));
  assert.ok(!out.includes("gsk_"));
  assert.ok(out.includes('"model":"m"'), "only keys are blanked");
  assert.deepEqual(JSON.parse(out).settings.creds.groq, { key: "", model: "m" });
  /* And it works on text that does not parse, which is the case it exists for. */
  assert.ok(!redactKeys('{"settings":{"key": "sk-live-123", "decks":{').includes("sk-live-123"));
});
