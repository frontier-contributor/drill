/* ============================================================================
 * CaptureBox — the lowest-friction thing in the app.
 *
 * Never calls the API: saves instantly, works offline, and appends rather
 * than replaces, so logging twice in a day just adds to that day's entry.
 * That last rule matters more than it looks — see START-HERE.md §4 Stage 1.
 *
 * Files go through the same reader chat uses (services/files/ingest), for text
 * only: a PDF, a Word document or a spreadsheet lands in today's raw log as the
 * text in it. Reading a file is local, so that rule still holds.
 * ========================================================================== */
import { useRef, useState } from "react";
import * as journalStore from "@/services/journalStore";
import { useToast } from "@/context/ToastContext";
import { acceptFor, TEXT_ONLY_KINDS } from "@/lib/files/kinds";
import { ago } from "@/lib/util";
import type { JournalEntry } from "@/types/journal";

/* Derived, not written out: this box keeps text, so it takes everything the
   app reads except a picture — which ingest refuses here with its own
   sentence. The list it used to carry named ten extensions out of sixty. */
const ACCEPT = acceptFor(TEXT_ONLY_KINDS);

export default function CaptureBox({ entry }: { entry: JournalEntry }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function save() {
    const t = text.trim();
    if (!t) return;
    journalStore.appendRaw(entry, "typed", "", t);
    setText("");
    toast("Added to today's log");
  }

  async function readFiles(list: FileList | File[]) {
    const files = Array.from(list);
    if (!files.length) return;
    const { ingest } = await import("@/services/files/ingest");
    for (const f of files) {
      setReading(f.name);
      try {
        const a = await ingest(f, { purpose: "text" });
        journalStore.appendRaw(entry, "file", a.name, a.text);
        toast(`Added ${a.name} to today's log${a.truncated ? " (clipped at the limit)" : ""}`);
      } catch (e) {
        toast((e as Error).message || `Could not read ${f.name}`, 8000);
      } finally {
        setReading(null);
      }
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    void readFiles(files);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) void readFiles(e.dataTransfer.files);
  }

  return (
    <div
      className={"jrnl-capture" + (dragOver ? " jrnl-drop" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <label className="f">What did you do today?</label>
      <textarea
        className="fi"
        style={{ minHeight: 100 }}
        placeholder="what you did, what you read, what confused you, links, anything — drop a PDF, Word, Excel or text file too"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") save();
        }}
      />
      <div className="btnrow">
        <button className="btn pri" onClick={save}>
          Add to today's log
        </button>
        <button className="btn sm" disabled={!!reading} onClick={() => fileRef.current?.click()}>
          {reading ? `Reading ${reading}…` : "Attach a file…"}
        </button>
      </div>
      <input ref={fileRef} type="file" multiple accept={ACCEPT} className="hidden-file" onChange={onFile} />

      {entry.raw.length > 0 && (
        <div className="jrnl-rawlist">
          {entry.raw
            .slice()
            .reverse()
            .map((r) => (
              <div key={r.id} className="jrnl-rawitem">
                <span className="tagmini">
                  {r.via}
                  {r.label ? ` · ${r.label}` : ""} · {ago(r.at)}
                </span>
                <div className="jrnl-rawtext">{r.text.length > 320 ? r.text.slice(0, 320) + "…" : r.text}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
