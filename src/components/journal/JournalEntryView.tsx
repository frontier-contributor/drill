/* ============================================================================
 * JournalEntryView — the narrative plus the seven structured fields.
 *
 * The narrative is regenerable: raw text is kept forever (CaptureBox never
 * touches this component), so a bad entry is one click to redo. An edited
 * entry is flagged so regeneration warns before overwriting hand edits.
 *
 * It is written from two things now: what you typed, and what the app logged
 * for that day (lib/dayBrief.ts, shown above by DayRecord). Either alone is
 * enough. Before, the capture box was the only input, so the button was dead
 * on a day spent drilling, chatting and sitting an exam without typing
 * anything — the one section whose job is to say what happened, refusing
 * because nobody had told it.
 * ========================================================================== */
import { useState } from "react";
import * as AI from "@/services/ai";
import * as journalStore from "@/services/journalStore";
import { collectDay, dayWindow, isEmptyDay, renderDay } from "@/lib/dayBrief";
import { useToast } from "@/context/ToastContext";
import type { JournalEntry, JournalSummary } from "@/types/journal";
import type { Project } from "@/types/core";
import Working from "../ui/Working";

function FieldBlock({
  label,
  value,
  onSave
}: {
  label: string;
  value: string[];
  onSave: (v: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value.join("\n"));

  if (editing) {
    return (
      <div className="jrnl-field">
        <span className="tagmini">{label}</span>
        <textarea className="fi" style={{ minHeight: 70 }} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="btnrow" style={{ marginTop: 4, marginBottom: 0 }}>
          <button
            className="btn sm pri"
            onClick={() => {
              onSave(
                text
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean)
              );
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="btn sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="jrnl-field">
      <div className="jrnl-fieldhead">
        <span className="tagmini">{label}</span>
        <button
          className="linkbtn"
          onClick={() => {
            setText(value.join("\n"));
            setEditing(true);
          }}
        >
          edit
        </button>
      </div>
      {value.length ? (
        <ul className="jrnl-list">
          {value.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      ) : (
        <div className="jrnl-empty-field">—</div>
      )}
    </div>
  );
}

export default function JournalEntryView({
  entry,
  project,
  onDistill
}: {
  entry: JournalEntry;
  project: Project;
  onDistill: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingNarrative, setEditingNarrative] = useState(false);
  const [narrativeDraft, setNarrativeDraft] = useState(entry.summary?.narrative || "");

  const rawText = entry.raw.map((r) => (r.label ? `[${r.label}]\n` : "") + r.text).join("\n\n---\n\n");
  const s = entry.summary;

  /* The day as the app logged it, for this entry's own day rather than for
     right now — writing up yesterday must not be handed this morning's
     reviews, in a record whose whole promise is that it is what happened. */
  const record = (() => {
    const w = dayWindow(entry.day);
    if (!w) return null;
    const r = collectDay(entry.projectId, w);
    return isEmptyDay(r) ? null : renderDay(r);
  })();
  const canWrite = !!rawText.trim() || !!record;

  function generate() {
    if (!canWrite) {
      toast("Nothing logged for this day yet — study something, or write a line above");
      return;
    }
    if (s && entry.edited) {
      if (!window.confirm("This entry was hand-edited. Regenerating overwrites those edits. Continue?")) return;
    }
    setBusy(true);
    setError(null);
    AI.writeJournal(rawText, project, record || undefined)
      .then((summary) => {
        journalStore.setSummary(entry, summary);
        toast("Journal written");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function patch(field: keyof JournalSummary, value: unknown) {
    journalStore.editSummary(entry, { [field]: value } as Partial<JournalSummary>);
  }

  return (
    <div className="jrnl-entry">
      {error && <div className="err">{error}</div>}
      {busy && (
        <div className="empty">
          <Working stages={["reading the day", "reading what you wrote", "finding the shape of it", "naming what you got stuck on", "writing it up"]} />
        </div>
      )}

      {!busy && !s && (
        <div className="empty">
          {canWrite
            ? rawText.trim()
              ? "Not written yet — write it up below."
              : "Nothing typed, but the day has a record of its own. Write it up and it will be written from that."
            : "Nothing logged for this day yet."}
        </div>
      )}

      {!busy && s && (
        <>
          {editingNarrative ? (
            <div className="jrnl-field">
              <textarea
                className="fi"
                style={{ minHeight: 90 }}
                value={narrativeDraft}
                onChange={(e) => setNarrativeDraft(e.target.value)}
                autoFocus
              />
              <div className="btnrow" style={{ marginTop: 4 }}>
                <button
                  className="btn sm pri"
                  onClick={() => {
                    patch("narrative", narrativeDraft.trim());
                    setEditingNarrative(false);
                  }}
                >
                  Save
                </button>
                <button className="btn sm" onClick={() => setEditingNarrative(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              className="jrnl-narrative"
              onDoubleClick={() => {
                setNarrativeDraft(s.narrative);
                setEditingNarrative(true);
              }}
              title="Double-click to edit"
            >
              {s.narrative}
            </p>
          )}

          <FieldBlock label="Did" value={s.did} onSave={(v) => patch("did", v)} />
          <FieldBlock label="Learned" value={s.learned} onSave={(v) => patch("learned", v)} />
          <FieldBlock label="Stuck" value={s.stuck} onSave={(v) => patch("stuck", v)} />
          <FieldBlock label="Open" value={s.open} onSave={(v) => patch("open", v)} />
          {s.resources.length > 0 && (
            <div className="jrnl-field">
              <span className="tagmini">Resources</span>
              <ul className="jrnl-list">
                {s.resources.map((r, i) => (
                  <li key={i}>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.label || r.url}</a> : r.label}</li>
                ))}
              </ul>
            </div>
          )}
          <FieldBlock label="Next up" value={s.nextUp} onSave={(v) => patch("nextUp", v)} />

          {entry.edited && <div className="hintline jrnl-edited-flag">Hand-edited — regenerating will ask first.</div>}
          {entry.distilled.at && (
            <div className="hintline">
              Distilled already — {entry.distilled.memoryIds.length} memor{entry.distilled.memoryIds.length === 1 ? "y" : "ies"},{" "}
              {entry.distilled.cardIds.length} card{entry.distilled.cardIds.length === 1 ? "" : "s"}. Running it again proposes only
              what's new.
            </div>
          )}
        </>
      )}

      {/* "Distill" meant nothing to anyone who had not read the source. A verb
          with no object is a bad button, so the button says what it produces
          and a line underneath says where the two piles go. */}
      <div className="btnrow" style={{ marginTop: 6 }}>
        <button className="btn" disabled={busy || !canWrite} onClick={generate}>
          {s ? "Regenerate" : "Write this day up"}
        </button>
        {s && (
          <button className="btn pri" onClick={onDistill} disabled={busy}>
            Turn this into memory and cards
          </button>
        )}
      </div>
      {s && (
        <div className="hintline" style={{ marginTop: 10 }}>
          Reads this entry and proposes two things: <b>memories</b> — what is durable about how you think and what you
          have settled on, which the tutor sees in every future chat — and <b>cards</b>, weighted toward what you got
          stuck on. Nothing is saved without you choosing it.
        </div>
      )}
    </div>
  );
}
