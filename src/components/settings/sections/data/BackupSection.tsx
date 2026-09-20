/* ============================================================================
 * BackupSection — the whole browser, out to one file and back in.
 *
 * This is the reason the Data page exists. It used to live in the review
 * loop's Menu, behind a sheet that is only mounted while the review loop is
 * on screen — so from chat, home, the journal or the exam view there was no
 * route to it at all, and the person who went looking for it in Settings,
 * which is where it belongs, did not find it. Nothing else in the app can
 * lose you months of review history, and nothing else can get it back.
 *
 * Restore is confirmed against both summaries, side by side. "Replace
 * everything" is not a thing to click on a description of the incoming file
 * alone — you want to see what you are about to lose next to what you are
 * about to gain.
 * ========================================================================== */
import { useEffect, useRef, useState } from "react";
import * as backup from "@/services/backup";
import * as filesDb from "@/services/files/db";
import { size } from "@/lib/files/limits";
import SwitchRow from "../../../ui/SwitchRow";
import { useToast } from "@/context/ToastContext";
import { useMaybeReview } from "@/context/ReviewContext";
import Section from "../../Section";
import Item from "../../../ui/Item";
import type { BackupSummary, FullBackup } from "@/types";

/** One line per thing the backup holds, skipping what it has none of. */
export function describe(s: BackupSummary): string {
  const bits = [
    s.projects + " project" + (s.projects === 1 ? "" : "s"),
    s.decks + " deck" + (s.decks === 1 ? "" : "s"),
    s.cards + " cards",
    s.conversations + " conversation" + (s.conversations === 1 ? "" : "s"),
    s.notes + " note" + (s.notes === 1 ? "" : "s")
  ];
  if (s.memories) bits.push(s.memories + " memories");
  if (s.figures) bits.push(s.figures + " kept figure" + (s.figures === 1 ? "" : "s"));
  if (s.files) bits.push(s.files + " attached file" + (s.files === 1 ? "" : "s"));
  return bits.join(" · ");
}

export default function BackupSection() {
  const toast = useToast();
  /* Settings opens over every section, so this runs both inside the review
     loop and well outside it. Refreshing the queue is right where there is
     one and meaningless where there is not, which is what the "maybe" is. */
  const review = useMaybeReview();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /* A parsed backup waiting on confirmation, with what it would replace. */
  const [pending, setPending] = useState<{
    file: FullBackup;
    incoming: BackupSummary;
    current: BackupSummary;
  } | null>(null);
  const [withFiles, setWithFiles] = useState(false);
  const [kept, setKept] = useState<{ count: number; bytes: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void filesDb.list().then((all) => {
      if (alive) setKept({ count: all.length, bytes: all.reduce((n, f) => n + f.size, 0) });
    });
    return () => {
      alive = false;
    };
  }, []);

  function saveEverything() {
    setBusy(true);
    setErr(null);
    backup
      .downloadEverything({ includeFiles: withFiles })
      .then(() => toast("Backup saved"))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  }

  /** Read the file and show both summaries. Nothing is replaced until the
   *  user confirms against what they can see. */
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files && e.target.files[0];
    e.target.value = ""; // so picking the same file twice still fires
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const file = backup.parse(String(rd.result));
        setErr(null);
        setBusy(true);
        void backup
          .summariseCurrent()
          .then((current) => setPending({ file, incoming: backup.summarise(file), current }))
          .catch((e: Error) => setErr(e.message))
          .finally(() => setBusy(false));
      } catch (e) {
        setPending(null);
        setErr((e as Error).message);
      }
    };
    rd.readAsText(f);
  }

  function confirmRestore() {
    if (!pending) return;
    setBusy(true);
    backup
      .restoreEverything(pending.file)
      .then((s) => {
        setPending(null);
        review?.refresh();
        toast("Restored — " + describe(s));
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  }

  return (
    <Section id="data.backup">
      <div className="list">
        <Item
          title="Back up everything"
          sub="decks, progress, chats, journal, notes and memory — one file"
          chev="↓"
          onClick={saveEverything}
        />
        <Item
          title="Restore from a backup…"
          sub="replaces everything currently in the app"
          chev="↑"
          onClick={() => fileRef.current?.click()}
        />
      </div>
      {!!kept?.count && (
        <SwitchRow
          title="Include attached files"
          sub={`${kept.count} picture${kept.count === 1 ? "" : "s"} and PDFs, ${size(kept.bytes)} — written as base64, so the backup grows by about a third more than that. Without them, chats keep their text but not the originals.`}
          on={withFiles}
          onToggle={() => setWithFiles((v) => !v)}
        />
      )}
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden-file" onChange={onFile} />

      {busy && !pending && <p className="sset-note">Working…</p>}
      {err && <div className="err">{err}</div>}

      {pending && (
        <div className="restore-confirm">
          <strong>Restore this backup?</strong>
          <p className="sset-note">
            From {pending.incoming.exportedAt ? new Date(pending.incoming.exportedAt).toLocaleString() : "an unknown date"}.
            Everything currently in the app is replaced — save a backup of what you have first if you are unsure.
          </p>
          <dl className="restore-diff">
            <div>
              <dt>Coming in</dt>
              <dd>{describe(pending.incoming)}</dd>
            </div>
            <div>
              <dt>Here now</dt>
              <dd>{describe(pending.current)}</dd>
            </div>
          </dl>
          <div className="btnrow">
            <button className="btn pri" disabled={busy} onClick={confirmRestore}>
              Replace everything
            </button>
            <button className="btn sm" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
