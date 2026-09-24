/* ============================================================================
 * BackupNudge — one line on Home when your work is less safe than you think.
 *
 * The Data page explains the risk well and nobody reads it until afterwards.
 * Home is the page opened every day, so the reminder goes here — quiet, one
 * line and its buttons, and only when it has something true to say:
 *
 *   paused   automatic backups are set up but the browser wants permission
 *            again; the button is the click the permission prompt needs
 *   failed   the last automatic one did not complete
 *   stale    no backup of any kind for `settings.backupRemind` days, and
 *            there is enough here that losing it would hurt
 *
 * "Enough here" is the rule that keeps it from nagging on day one: twenty
 * reviews, or a few conversations or notes. A starter deck is not a stake.
 * "Not now" is honoured for three days. Nothing is shown when a folder is
 * writing backups on its own — that is the state this exists to get you to.
 * ========================================================================== */
import { useState } from "react";
import * as autoBackup from "@/services/autoBackup";
import * as storage from "@/services/storage";
import * as store from "@/services/store";
import * as chatStore from "@/services/chatStore";
import { useStoreSync } from "@/hooks/useStoreSync";
import { useSettings } from "@/context/SettingsContext";
import { useToast } from "@/context/ToastContext";
import { DAY } from "@/lib/util";

const SNOOZE = 3 * DAY;

/** A rough measure of how much would be lost, in reviews. A conversation or
 *  a note is worth several: each one is something you wrote. */
function stake(): { reviews: number; conversations: number; score: number } {
  const db = store.get();
  const conversations = chatStore.list().length;
  const reviews = db.log.length;
  return { reviews, conversations, score: reviews + 5 * conversations + 5 * db.notes.length };
}

/** When this browser started holding anything — the oldest deck or review. */
function firstUse(): number {
  const db = store.get();
  let t = db.log.length ? db.log[0].t : Date.now();
  for (const d of Object.values(db.decks)) if (d.created && d.created < t) t = d.created;
  return t;
}

function days(ms: number): string {
  const n = Math.floor(ms / DAY);
  return n <= 1 ? "a day" : `${n} days`;
}

export default function BackupNudge() {
  useStoreSync(autoBackup);
  useStoreSync(chatStore);
  const settings = useSettings();
  const toast = useToast();
  const [snoozed, setSnoozed] = useState(() => storage.backupSnoozedUntil() > Date.now());
  const [busy, setBusy] = useState(false);

  const auto = autoBackup.current();
  const remind = store.settings().backupRemind;
  const last = storage.lastBackup();
  const now = Date.now();

  function download() {
    setBusy(true);
    import("@/services/backup")
      .then((b) => b.downloadEverything())
      .then(() => toast("Backup saved — keep it somewhere that is not this browser"))
      .catch((e: Error) => toast("Backup failed: " + e.message, 5000))
      .finally(() => setBusy(false));
  }

  function notNow() {
    storage.snoozeBackupNudge(Date.now() + SNOOZE);
    setSnoozed(true);
  }

  let line: string | null = null;
  let acts: JSX.Element | null = null;

  if (auto.status === "paused" && !snoozed) {
    line = `Automatic backups are paused — the browser wants your say-so again before it writes to “${auto.folder}”.`;
    acts = (
      <>
        <button className="btn sm pri" onClick={() => void autoBackup.resume()}>
          Allow and back up
        </button>
        <button className="btn sm" onClick={notNow}>
          Not now
        </button>
      </>
    );
  } else if (auto.status === "on" && auto.error && !auto.busy) {
    line = "The last automatic backup did not finish: " + auto.error;
    acts = (
      <>
        <button className="btn sm" onClick={() => void autoBackup.runNow()}>
          Try again
        </button>
        <button className="btn sm" onClick={() => settings.open("data", "data.auto")}>
          Settings
        </button>
      </>
    );
  } else if (auto.status !== "on" && remind > 0 && !snoozed) {
    const since = last ? last.at : firstUse();
    const s = stake();
    if (now - since >= remind * DAY && s.score >= 25) {
      const what = [
        s.reviews ? `${s.reviews.toLocaleString()} review${s.reviews === 1 ? "" : "s"}` : "",
        s.conversations ? `${s.conversations} conversation${s.conversations === 1 ? "" : "s"}` : ""
      ]
        .filter(Boolean)
        .join(" and ");
      line = last
        ? `Your last backup was ${days(now - last.at)} ago. Everything since lives only in this browser.`
        : `Nothing here has been backed up yet. ${what ? what[0].toUpperCase() + what.slice(1) : "Your notes"} exist only in this browser.`;
      acts = (
        <>
          <button className="btn sm pri" disabled={busy} onClick={download}>
            {busy ? "Saving…" : "Back up now"}
          </button>
          {auto.status === "off" && (
            <button className="btn sm" onClick={() => void autoBackup.link()}>
              Back up automatically…
            </button>
          )}
          <button className="btn sm" onClick={notNow}>
            Not now
          </button>
        </>
      );
    }
  }

  if (!line) return null;
  return (
    <div className="home-nudge" role="status">
      <p>{line}</p>
      <div className="home-nudge-acts">{acts}</div>
    </div>
  );
}
