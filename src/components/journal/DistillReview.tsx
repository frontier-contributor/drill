/* ============================================================================
 * DistillReview — one journal entry in, two reviewable piles out.
 *
 * Nothing commits itself: memory candidates land in the tray (services/
 * candidates.ts), cards go through the same ProposalsBlock every other
 * card-generating surface uses. entry.distilled records what already went
 * through, so running this twice on the same entry proposes only what the
 * first pass didn't cover — see journalStore.markDistilled.
 * ========================================================================== */
import { useEffect, useState } from "react";
import * as AI from "@/services/ai";
import * as store from "@/services/store";
import * as candidates from "@/services/candidates";
import * as memoryStore from "@/services/memoryStore";
import * as journalStore from "@/services/journalStore";
import { findDuplicates } from "@/lib/cardGate";
import { useToast } from "@/context/ToastContext";
import ProposalsBlock from "../ProposalsBlock";
import type { JournalEntry } from "@/types/journal";
import type { Project } from "@/types/core";
import type { Card, MemoryType } from "@/types";
import Icon from "../ui/Icon";
import Working from "../ui/Working";

interface MemDraft {
  type: MemoryType;
  text: string;
  on: boolean;
}

export default function DistillReview({ entry, project, onClose }: { entry: JournalEntry; project: Project; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memDrafts, setMemDrafts] = useState<MemDraft[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [dupes, setDupes] = useState<Map<number, { existing: Card; score: number }>>(new Map());
  const [memDone, setMemDone] = useState(false);

  useEffect(() => {
    const existing = store.decksOf(project.id).flatMap((d) => d.cards);
    /* activeOnly matters: a retired memory was usually retired because it was
       wrong. Listing its text as "already captured" tells the model not to
       restate it, which suppresses the correction. */
    const existingMemoryTexts = [
      ...memoryStore.list({ scope: "project", projectId: project.id, activeOnly: true }).map((m) => m.text),
      ...candidates.pending(project.id).filter((c) => c.scope === "project").map((c) => c.text)
    ];
    AI.distill(entry, project, existing.map((c) => ({ tag: c.tag, q: c.q })), existingMemoryTexts)
      .then((r) => {
        setMemDrafts(r.memories.map((m) => ({ ...m, on: true })));
        setCards(r.cards);
        setDupes(findDuplicates(r.cards, existing));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
    // Runs once per mount — DistillReview is remounted (new entry.id key) rather
    // than re-run in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleMem(i: number) {
    setMemDrafts((prev) => prev.map((m, j) => (j === i ? { ...m, on: !m.on } : m)));
  }

  function commitMemories() {
    const chosen = memDrafts.filter((m) => m.on);
    if (!chosen.length) {
      toast("Nothing selected");
      return;
    }
    const { committed, queued } = candidates.propose(
      chosen.map((m) => ({ scope: "project" as const, projectId: project.id, type: m.type, text: m.text, origin: null }))
    );
    journalStore.markDistilled(entry, [...committed, ...queued].map((m) => m.id), []);
    /* What happened depends on the project's autonomy policy, so say which —
       "sent to the tray" when nothing went to the tray is how a user learns
       to distrust the messages. */
    const parts: string[] = [];
    if (committed.length) parts.push(`${committed.length} saved to memory`);
    if (queued.length) parts.push(`${queued.length} waiting in the tray`);
    toast(parts.join(" · ") || "Nothing to save");
    setMemDrafts([]);
    setMemDone(true);
  }

  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h3>Memory and cards</h3>
          <span className="sub">from {entry.day}</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">
          {busy && (
            <Working
              stages={[
                "reading the entry",
                "looking for what is durable",
                "throwing out what the review log already knows",
                "drafting cards from what you got stuck on",
                "checking nothing repeats what you already have"
              ]}
            />
          )}
          {error && <div className="err">{error}</div>}

          {!busy && !error && (
            <>
              <label className="f">Memory candidates</label>
              {memDrafts.length === 0 ? (
                <div className="empty">{memDone ? "Sent to the tray." : "Nothing durable enough to remember from this entry."}</div>
              ) : (
                <>
                  {memDrafts.map((m, i) => (
                    <div key={i} className={"prop" + (m.on ? "" : " off")}>
                      <div className="ph">
                        <button className={"toggle" + (m.on ? " on" : "")} onClick={() => toggleMem(i)}>
                          {m.on ? "✓" : ""}
                        </button>
                        <div className="grow">
                          <span className="tagmini">{m.type}</span>
                          <div className="qmini">{m.text}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="btnrow" style={{ marginBottom: 20 }}>
                    <button className="btn pri sm" onClick={commitMemories}>
                      Send {memDrafts.filter((m) => m.on).length} to the memory tray
                    </button>
                  </div>
                </>
              )}

              <label className="f" style={{ marginTop: 12 }}>
                Card proposals
              </label>
              {cards.length === 0 ? (
                <div className="empty">Nothing worth drilling from this entry.</div>
              ) : (
                <>
                  {dupes.size > 0 && (
                    <div className="note" style={{ marginBottom: 10 }}>
                      {dupes.size === 1 ? "One of these looks" : `${dupes.size} of these look`} close to a card you
                      already have — greyed below, matched card shown.
                    </div>
                  )}
                  {dupes.size > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      {Array.from(dupes.entries()).map(([i, d]) => (
                        <div key={i} className="hintline">
                          "{cards[i]?.q.replace(/<[^>]+>/g, "").slice(0, 60)}" ≈ existing: "
                          {d.existing.q.replace(/<[^>]+>/g, "").slice(0, 60)}"
                        </div>
                      ))}
                    </div>
                  )}
                  <ProposalsBlock
                    label={`${cards.length} card${cards.length === 1 ? "" : "s"} — untick anything weak or duplicate`}
                    cards={cards}
                    sourceRef={{ kind: "journal", id: entry.id }}
                    onCommitted={(added) => {
                      journalStore.markDistilled(entry, [], added.map((c) => c.id));
                      toast(`${added.length} card${added.length === 1 ? "" : "s"} added`);
                      setCards([]);
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
