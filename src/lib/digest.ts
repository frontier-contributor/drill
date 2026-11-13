/* ============================================================================
 * digest.ts — a past conversation or an exam, read back as text.
 *
 * Two callers, one description, the rule lib/dayBrief.ts and lib/memoryBrief.ts
 * already follow: the assistant's `open` tool, when it goes and finds the
 * thread you mentioned, and the composer's "@", when you point at it yourself.
 * If they built the text separately, a chat you attached and a chat the model
 * looked up would read differently — and the model would be answering two
 * different accounts of one conversation depending on how it arrived.
 *
 * Pure: takes records, returns strings. The stores are the callers' business.
 * ========================================================================== */
import type { Conversation, Turn } from "@/types/chat";
import type { Exam } from "@/types/exam";
import { ago } from "@/lib/util";

function said(t: Turn): string {
  return t.variants[t.active]?.content || "";
}

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * What a thread was about, then as much of its end as fits.
 *
 * The opening message says what the thread was for and the end says where it
 * got to — the two halves a later conversation needs to pick it up. The middle
 * is what gets dropped, and the digest says how much, because a model that
 * thinks it read a whole conversation will answer as if it had.
 */
export function chatDigest(c: Conversation, opts: { where?: string; budget?: number } = {}): string {
  const budget = opts.budget ?? 3200;
  const head =
    `[chat:${c.id}] "${c.title}" — ${c.turns.length} messages, started ${ago(c.created)}, last ${ago(c.updated)}` +
    (opts.where ? ` (in ${opts.where})` : "");
  const line = (t: Turn) => `${t.role === "user" ? "Learner" : "Assistant"}: ${clip(said(t), t.role === "user" ? 400 : 600)}`;
  const turns = c.turns.filter((t) => said(t).trim());
  if (!turns.length) return head + "\nNothing was said in it.";
  const first = line(turns[0]);
  const tail: string[] = [];
  let room = budget - head.length - first.length;
  for (let i = turns.length - 1; i > 0; i--) {
    const l = line(turns[i]);
    if (l.length > room) break;
    tail.unshift(l);
    room -= l.length + 1;
  }
  const skipped = turns.length - 1 - tail.length;
  return [head, first, skipped > 0 ? `…${skipped} message${skipped === 1 ? "" : "s"} in between not shown…` : "", ...tail]
    .filter(Boolean)
    .join("\n");
}

/** An exam question by question: what was asked, what they wrote, and what
 *  the marking said was missing — the last being the most specific thing the
 *  app ever records about what someone does not understand. */
export function examDigest(e: Exam, opts: { where?: string } = {}): string {
  const graded = e.questions.filter((q) => q.result);
  const tally = (v: string) => graded.filter((q) => q.result!.verdict === v).length;
  const head =
    `[exam:${e.id}] "${e.title}" — ${e.questions.length} questions, ${ago(e.created)}` +
    (opts.where ? ` (in ${opts.where})` : "") +
    (graded.length ? `. ${tally("got")} got, ${tally("partial")} partly, ${tally("missed")} missed.` : ". Not sat yet.");
  const rows = e.questions.map((q, i) => {
    const bits = [`${i + 1}. ${q.result ? `[${q.result.verdict}] ` : ""}${clip(q.prompt, 220)}`];
    if (q.answer) bits.push(`   They wrote: "${clip(q.answer, 220)}"`);
    if (q.result?.missing.length) bits.push(`   Missing: ${q.result.missing.join("; ")}`);
    return bits.join("\n");
  });
  return [head, ...rows].join("\n");
}
