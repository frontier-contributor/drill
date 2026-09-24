/* ============================================================================
 * BridgeSheet — bring a study session from another AI into the journal.
 *
 * Three steps on one sheet, top to bottom, because each is one action:
 *
 *   1. Copy a prompt (lib/capture.ts) that knows this project, and paste it at
 *      the end of the conversation you had elsewhere.
 *   2. Paste that AI's reply back here. It is read as you paste — locally, no
 *      call, no key needed — and says what it found or why it found nothing.
 *   3. Review the piles the way distill's are reviewed: the day's record and
 *      the insights worth keeping, the memory proposals, the cards. Each pile
 *      is committed by its own button, and nothing is committed by opening,
 *      pasting or closing.
 *
 * Cards go through the same ProposalsBlock every card-writing surface uses,
 * cleaned by store.normCard first and checked against the project's cards for
 * duplicates; memories go through candidates.propose, so the project's
 * autonomy policy decides whether they land or wait in the tray; the record
 * goes into today's raw log, where the journal writer and distill will read it.
 * ========================================================================== */
import { useEffect, useMemo, useState } from "react";
import * as store from "@/services/store";
import * as candidates from "@/services/candidates";
import * as journalStore from "@/services/journalStore";
import { gapsFrom } from "@/lib/gaps";
import { findDuplicates } from "@/lib/cardGate";
import { BridgeParseError, bridgePrompt, journalText, parseBridgeReply, type BridgeReply } from "@/lib/capture";
import { useToast } from "@/context/ToastContext";
import ProposalsBlock from "../ProposalsBlock";
import Icon from "../ui/Icon";
import type { JournalEntry } from "@/types/journal";
import type { Card } from "@/types";

interface Toggled<T> {
  item: T;
  on: boolean;
}

export default function BridgeSheet({ entry, onClose }: { entry: JournalEntry; onClose: () => void }) {
  const toast = useToast();
  const project = store.projects()[entry.projectId];
  const [source, setSource] = useState("");
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);

  const prompt = useMemo(() => {
    const decks = store.decksOf(entry.projectId);
    const tags = [...new Set(decks.flatMap((d) => d.cards.map((c) => c.tag)).filter(Boolean))];
    return bridgePrompt({
      projectName: project?.name || "my studies",
      goals: project?.goals || "",
      gaps: gapsFrom(store.logOf(decks), { limit: 6 }).map((g) => g.text),
      tags
    });
  }, [entry.projectId, project]);

  /* Read as you paste. A parse is a few string scans; there is nothing to
     wait for, and seeing "found 8 cards" the moment you paste is the answer
     to "did I copy the right thing". */
  const parsed = useMemo((): { reply: BridgeReply | null; error: string | null } => {
    if (!pasted.trim()) return { reply: null, error: null };
    try {
      return { reply: parseBridgeReply(pasted), error: null };
    } catch (e) {
      return { reply: null, error: e instanceof BridgeParseError ? e.message : String(e) };
    }
  }, [pasted]);

  /* The review state, rebuilt whenever a different reply is read. */
  const [notes, setNotes] = useState<Toggled<string>[]>([]);
  const [mems, setMems] = useState<Toggled<{ type: string; text: string }>[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [dupes, setDupes] = useState<Map<number, { existing: Card; score: number }>>(new Map());
  const [logged, setLogged] = useState(false);
  const [memDone, setMemDone] = useState(false);
  const [cardsDone, setCardsDone] = useState(false);
  /* ProposalsBlock sets its ticks once, on mount, so a new reply has to be a
     new block. */
  const [gen, setGen] = useState(0);

  useEffect(() => {
    const r = parsed.reply;
    setGen((g) => g + 1);
    setLogged(false);
    setMemDone(false);
    setCardsDone(false);
    if (!r) {
      setNotes([]);
      setMems([]);
      setCards([]);
      setDupes(new Map());
      return;
    }
    setNotes(r.notes.map((n) => ({ item: n, on: true })));
    /* Open questions are offered as memories too: an `open` memory is the
       kind the app deliberately brings back up, which is what an unresolved
       question from a session elsewhere most needs. */
    setMems([
      ...r.memories.map((m) => ({ item: m as { type: string; text: string }, on: true })),
      ...r.open.map((o) => ({ item: { type: "open", text: o }, on: true }))
    ]);
    const existing = store.decksOf(entry.projectId).flatMap((d) => d.cards);
    const made = r.cards.map((c) => store.normCard({ tag: c.tag || "Imported", q: c.q, a: c.a }));
    setCards(made);
    setDupes(findDuplicates(made, existing));
  }, [parsed.reply, entry.projectId]);

  function copy() {
    void navigator.clipboard?.writeText(prompt).then(
      () => {
        setCopied(true);
        toast("Copied — paste it at the end of the other conversation");
      },
      () => toast("The browser would not copy. Select the prompt and copy it by hand.", 5000)
    );
  }

  const label = source.trim() || "another AI";

  function logDay() {
    const r = parsed.reply;
    if (!r) return;
    const keptNotes = notes.filter((n) => n.on).map((n) => n.item);
    const text = journalText(r, keptNotes, cards.length);
    if (text) journalStore.appendRaw(entry, "elsewhere", label, text);
    for (const n of keptNotes) store.addNote(n, "From " + label, { projectId: entry.projectId, source: "capture" });
    setLogged(true);
    toast(
      `Added to today's log` + (keptNotes.length ? ` · ${keptNotes.length} note${keptNotes.length === 1 ? "" : "s"} kept` : "")
    );
  }

  function sendMemories() {
    const chosen = mems.filter((m) => m.on);
    if (!chosen.length) {
      toast("Nothing selected");
      return;
    }
    const { committed, queued } = candidates.propose(
      chosen.map((m) => ({
        scope: "project" as const,
        projectId: entry.projectId,
        type: m.item.type as "understanding",
        text: m.item.text,
        origin: null
      }))
    );
    const parts: string[] = [];
    if (committed.length) parts.push(`${committed.length} saved to memory`);
    if (queued.length) parts.push(`${queued.length} waiting in the tray`);
    toast(parts.join(" · ") || "Nothing to save");
    setMemDone(true);
  }

  const r = parsed.reply;

  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        /* A stray click beside the sheet should not throw away a pasted
           session; once there is one, only the close button closes it. */
        if (e.target === e.currentTarget && !pasted.trim()) onClose();
      }}
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h3>From another AI</h3>
          <span className="sub">bring a session into {entry.day}</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">
          <label className="f">1 · Copy this into the conversation you had elsewhere</label>
          <p className="hintline bridge-lead">
            At the end of a session in ChatGPT, Claude, Gemini or anything else, paste this as your next message. It knows
            this project, so the cards it writes are aimed at it.
          </p>
          <textarea className="fi mono bridge-prompt" readOnly value={prompt} onFocus={(e) => e.currentTarget.select()} />
          <div className="btnrow">
            <button className="btn pri sm" onClick={copy}>
              {copied ? "Copied" : "Copy the prompt"}
            </button>
          </div>

          <label className="f">2 · Paste its whole reply here</label>
          <textarea
            className="fi bridge-paste"
            placeholder="the reply, including the ```drill block"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <input
            className="fi"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="where it was — ChatGPT, Claude, a course tutor (optional)"
          />
          {parsed.error && <div className="err">{parsed.error}</div>}
          {r && (
            <p className="hintline ok">
              Read {[
                r.summary ? "a summary" : "",
                r.cards.length ? `${r.cards.length} card${r.cards.length === 1 ? "" : "s"}` : "",
                r.notes.length ? `${r.notes.length} note${r.notes.length === 1 ? "" : "s"}` : "",
                r.memories.length ? `${r.memories.length} memor${r.memories.length === 1 ? "y" : "ies"}` : "",
                r.open.length ? `${r.open.length} open question${r.open.length === 1 ? "" : "s"}` : ""
              ]
                .filter(Boolean)
                .join(", ")}
              . Nothing is saved until you say so below.
            </p>
          )}
          {r?.problems.map((p) => (
            <div key={p} className="note">
              {p}
            </div>
          ))}

          {r && (
            <>
              <label className="f">3 · The day's record</label>
              {r.summary && <div className="bridge-summary">{r.summary}</div>}
              {notes.map((n, i) => (
                <div key={i} className={"prop" + (n.on ? "" : " off")}>
                  <div className="ph">
                    <button
                      className={"toggle" + (n.on ? " on" : "")}
                      aria-label={n.on ? "Leave out" : "Keep"}
                      disabled={logged}
                      onClick={() => setNotes((prev) => prev.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
                    >
                      {n.on ? "✓" : ""}
                    </button>
                    <div className="grow">
                      <span className="tagmini">note</span>
                      <div className="qmini">{n.item}</div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="btnrow">
                <button className="btn pri sm" disabled={logged} onClick={logDay}>
                  {logged
                    ? "In today's log"
                    : notes.some((n) => n.on)
                      ? `Add to today's log, and keep ${notes.filter((n) => n.on).length} as notes`
                      : "Add to today's log"}
                </button>
              </div>

              <label className="f">Memory</label>
              {mems.length === 0 ? (
                <div className="empty">Nothing it suggested remembering.</div>
              ) : memDone ? (
                <div className="empty">Sent — see the memory tray for anything waiting.</div>
              ) : (
                <>
                  {mems.map((m, i) => (
                    <div key={i} className={"prop" + (m.on ? "" : " off")}>
                      <div className="ph">
                        <button
                          className={"toggle" + (m.on ? " on" : "")}
                          aria-label={m.on ? "Leave out" : "Keep"}
                          onClick={() => setMems((prev) => prev.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
                        >
                          {m.on ? "✓" : ""}
                        </button>
                        <div className="grow">
                          <span className="tagmini">{m.item.type}</span>
                          <div className="qmini">{m.item.text}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="btnrow">
                    <button className="btn pri sm" onClick={sendMemories}>
                      Send {mems.filter((m) => m.on).length} to memory
                    </button>
                  </div>
                </>
              )}

              <label className="f">Cards</label>
              {cards.length === 0 ? (
                <div className="empty">{cardsDone ? "Added." : "No cards in this reply."}</div>
              ) : (
                <>
                  {dupes.size > 0 && (
                    <div className="note">
                      {dupes.size === 1 ? "One of these looks" : `${dupes.size} of these look`} close to a card you
                      already have — worth unticking.
                    </div>
                  )}
                  <ProposalsBlock
                    key={gen}
                    label={`${cards.length} card${cards.length === 1 ? "" : "s"} — untick anything weak or duplicate`}
                    cards={cards}
                    sourceRef={{ kind: "journal", id: entry.id }}
                    onCommitted={(added) => {
                      toast(`${added.length} card${added.length === 1 ? "" : "s"} added`);
                      setCards([]);
                      setCardsDone(true);
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
