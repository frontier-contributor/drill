/* ============================================================================
 * AutoBackupSection — a folder Drill writes its own backups into, and the
 * reminder for browsers that cannot.
 *
 * The status line leads, because the question someone brings here is "am I
 * covered", and the answer is one of four sentences: covered (and since
 * when), covered once you let it back in, not set up, or not possible in this
 * browser. The buttons follow from whichever it is. services/autoBackup.ts has
 * the why of every state.
 * ========================================================================== */
import { useState } from "react";
import * as autoBackup from "@/services/autoBackup";
import * as storage from "@/services/storage";
import * as store from "@/services/store";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useDrillStore } from "@/hooks/useDrillStore";
import { ago, fmtBytes } from "@/lib/util";
import Section from "../../Section";
import SelectRow from "../../../ui/SelectRow";

const KEEP = [
  { value: "7", label: "A week of daily snapshots" },
  { value: "14", label: "Two weeks" },
  { value: "30", label: "A month" },
  { value: "90", label: "Three months" },
  { value: "0", label: "All of them — never delete" }
];

const REMIND = [
  { value: "3", label: "After 3 days without a backup" },
  { value: "7", label: "After a week" },
  { value: "14", label: "After two weeks" },
  { value: "30", label: "After a month" },
  { value: "0", label: "Never" }
];

export function lastLine(): string {
  const last = storage.lastBackup();
  if (!last) return "No backup has been made from this browser yet.";
  const where = last.how === "folder" ? "written to the folder" : "downloaded";
  return `Last backup ${ago(last.at)} — ${last.file}, ${fmtBytes(last.bytes)}, ${where}.`;
}

export default function AutoBackupSection() {
  useStoreSync(autoBackup);
  const db = useDrillStore();
  const st = autoBackup.current();
  const [confirmStop, setConfirmStop] = useState(false);

  const status =
    st.status === "on"
      ? `On — writing to the folder “${st.folder}”.`
      : st.status === "paused"
        ? `Paused. The browser needs your permission again before it will write to “${st.folder}”. That is normal after a restart unless you chose “Allow on every visit” when it asked.`
        : st.status === "off"
          ? "Off. Choose a folder and Drill backs itself up into it — a folder a sync client watches (Drive, Dropbox, OneDrive, iCloud) takes it off this machine too."
          : "This browser cannot write to a folder by itself — Chrome and Edge can. Here, the reminder below is what keeps a recent backup on disk.";

  return (
    <Section id="data.auto">
      <p className="sset-s">{status}</p>
      <p className={"sset-s" + (st.status === "on" && !st.error ? " ok" : "")}>{st.busy ? "Writing a backup now…" : lastLine()}</p>
      {st.error && <div className="err">{st.error}</div>}

      <div className="btnrow">
        {st.status === "off" && (
          <button className="btn pri" onClick={() => void autoBackup.link()}>
            Choose a folder…
          </button>
        )}
        {st.status === "paused" && (
          <button className="btn pri" onClick={() => void autoBackup.resume()}>
            Allow and back up
          </button>
        )}
        {st.status === "on" && (
          <button className="btn" disabled={st.busy} onClick={() => void autoBackup.runNow()}>
            Back up now
          </button>
        )}
        {(st.status === "on" || st.status === "paused") && (
          <>
            <button className="btn" onClick={() => void autoBackup.link()}>
              Change folder…
            </button>
            <button
              className={"btn" + (confirmStop ? " danger" : "")}
              onClick={() => {
                if (!confirmStop) return setConfirmStop(true);
                setConfirmStop(false);
                void autoBackup.unlink();
              }}
            >
              {confirmStop ? "Stop — the files already written stay" : "Stop"}
            </button>
          </>
        )}
      </div>

      {st.status !== "unsupported" && (
        <SelectRow
          title="How many to keep"
          sub="One file a day, named by its date. Older ones are removed from the folder — only files Drill named drill-auto-…, never anything else in it."
          value={String(db.settings.backupKeep)}
          options={KEEP}
          onChange={(v) => store.updateSettings({ backupKeep: Number(v) })}
        />
      )}
      <SelectRow
        title="Remind me on Home"
        sub="A quiet line on the front page when the last backup — downloaded or automatic — is older than this. Only once there is something to lose."
        value={String(db.settings.backupRemind)}
        options={REMIND}
        onChange={(v) => store.updateSettings({ backupRemind: Number(v) })}
      />
    </Section>
  );
}
