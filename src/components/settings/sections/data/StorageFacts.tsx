/* ============================================================================
 * StorageFacts — what you have made, where it is, how safe it is there, and
 * the two buttons that make it safer.
 *
 * Deliberately the first thing on the Data page rather than a footnote under
 * the export buttons. "All of this lives in one browser" lands as a warning
 * only once you can see how much of it there is.
 *
 * The persistence button is here because asking at boot is not enough and
 * quietly was not working. Chrome grants `navigator.storage.persist()` on its
 * own heuristics; Firefox raises a permission prompt, and a prompt raised
 * during page load with no user gesture behind it is dismissed before anyone
 * sees it. A button is a gesture. That one difference is why a browser that
 * had been asked every single startup still evicted the database.
 * ========================================================================== */
import { useCallback, useEffect, useState } from "react";
import * as store from "@/services/store";
import * as storage from "@/services/storage";
import { LOCAL_STORAGE_BUDGET, pressure } from "@/lib/logBudget";
import { useDrillStore } from "@/hooks/useDrillStore";
import { fmtBytes } from "@/lib/util";
import Section from "../../Section";

export default function StorageFacts() {
  useDrillStore();
  const [health, setHealth] = useState<storage.StorageHealth | null>(null);
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);
  const report = store.initReport();
  const save = store.getSaveState();

  const refresh = useCallback(() => {
    void storage.storageHealth().then(setHealth);
  }, []);

  useEffect(refresh, [refresh]);

  function askForPersistence() {
    setAsking(true);
    setRefused(false);
    void storage
      .requestPersistence()
      .then((granted) => {
        setRefused(!granted);
        refresh();
      })
      .finally(() => setAsking(false));
  }

  const db = store.get();
  const nDecks = Object.keys(db.decks).length;
  const nCards = Object.values(db.decks).reduce((n, d) => n + d.cards.length, 0);
  const nProjects = Object.keys(db.projects).length;

  /* The review half lives in localStorage, which is the small drawer — about
     5MB for the whole origin, shared with nothing else. Everything else
     (chats, journal, memory, exams) is in IndexedDB, which is the large one.
     `health.usage` covers both and is the number that matters for eviction;
     this one is the number that matters for "the save just failed", so both
     are shown. */
  const localBytes = storage.storedBytes();
  const localShare = pressure(localBytes);

  return (
    <Section id="data.storage">
      <div className="sset-facts">
        <div>
          <b>{nProjects}</b>
          <span>projects</span>
        </div>
        <div>
          <b>{nDecks}</b>
          <span>decks</span>
        </div>
        <div>
          <b>{nCards}</b>
          <span>cards</span>
        </div>
        <div>
          <b>{db.log.length.toLocaleString()}</b>
          <span>reviews logged</span>
        </div>
        <div>
          <b>{fmtBytes(health?.usage ?? null)}</b>
          <span>on disk</span>
        </div>
      </div>

      {/* The drawer that actually fills up. A save failure is always this one,
          never the IndexedDB half, so this is the bar worth watching. */}
      {localShare != null && (
        <>
          <div className="quota" aria-hidden="true">
            <i className={localShare > 0.85 ? "hot" : localShare > 0.6 ? "warm" : ""} style={{ width: Math.max(2, localShare * 100) + "%" }} />
          </div>
          <p className={"sset-note" + (localShare > 0.85 ? " warn" : "")}>
            Decks, scheduling and your review log take {fmtBytes(localBytes)} of the roughly{" "}
            {fmtBytes(LOCAL_STORAGE_BUDGET)} this browser gives a site for that kind of storage
            {localShare > 0.85
              ? " — close enough that saves may start failing. Take a backup, and consider splitting or deleting a deck you have finished with."
              : "."}{" "}
            Chats, the journal, memory and exams are kept separately and have far more room.
          </p>
        </>
      )}

      {!save.ok && (
        <div className="err">
          Saving is currently failing{save.reason === "quota" ? " because that storage is full" : ""}. Nothing has
          been written since {new Date(save.at).toLocaleTimeString()}. Back up now, before closing this tab.
        </div>
      )}
      {save.ok && save.dropped > 0 && (
        <p className="sset-note warn">
          To keep saving, Drill forgot the oldest {save.dropped.toLocaleString()} reviews in the log. Cards,
          scheduling and everything else are untouched, but the earliest part of the activity calendar is gone.
        </p>
      )}

      {/* ------------------------------------------------ keeping it safe -- */}
      <div className="srow">
        <span className="grow">
          <span className="t">Ask this browser to keep Drill's data</span>
          <span className="s">
            {health?.persisted
              ? "Granted. The browser has agreed not to clear this site to reclaim space."
              : health?.supported === false
                ? "This browser will not say whether your data is safe from eviction, and cannot be asked. Keep a backup."
                : refused
                  ? "The browser said no. It usually says yes once you have used the site a few times, or after you bookmark or install it — try again then."
                  : "Not granted yet. Without it, the browser may clear this site when it is short of space."}
          </span>
        </span>
        {!health?.persisted && health?.supported !== false && (
          <button className="btn sm pri" disabled={asking} onClick={askForPersistence}>
            {asking ? "Asking…" : "Ask now"}
          </button>
        )}
      </div>

      {/* The guide. Written as what to do rather than what happened, because
          the person reading it has just lost something and wants the fix. */}
      <p className="sset-note">
        <b>Everything Drill knows is in this browser.</b> There is no account and no server, which is why nothing
        you write here is ever uploaded — and why nobody but you can get it back. Four things wipe it, and only the
        first is Drill's fault:
      </p>
      <ul className="guide">
        <li>
          <b>The browser reclaiming space.</b> The button above is the fix, and a backup is the belt to its braces.
        </li>
        <li>
          <b>Clearing cookies and site data.</b> "Clear browsing data" takes Drill with it, every time, however it
          is stored. Nothing can prevent that from inside the page.
        </li>
        <li>
          <b>A private or incognito window.</b> Everything is discarded when the last one closes. Drill works there;
          it just will not be there tomorrow.
        </li>
        <li>
          <b>A different address.</b> Storage belongs to <code>{window.location.origin}</code>, not to you. Another
          port, another domain, another browser or another device is a different, empty Drill.
        </li>
      </ul>
      <p className="sset-note">
        So: keep a recent backup somewhere that is not this browser. It is the file below, it takes a second, and it
        is the only copy that survives all four — and in Chrome or Edge, Automatic backups below will write it into a
        folder for you every day you use Drill.
      </p>

      {report.migrated && (
        <p className="sset-note">
          Upgraded from database v{report.fromVersion} on this load
          {report.backedUp ? " — a pre-upgrade backup was kept." : "."}
        </p>
      )}
    </Section>
  );
}
