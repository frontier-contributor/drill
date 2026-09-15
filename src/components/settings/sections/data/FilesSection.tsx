/* ============================================================================
 * FilesSection — the pictures and PDFs kept for conversations, and the ones
 * nothing uses any more.
 *
 * Attached files are the one thing in this app that can be large, and they are
 * kept the moment they are attached — so an attachment removed before sending,
 * or a deleted conversation, leaves bytes behind. They are found by reading
 * every conversation (services/files/sweep.ts), never removed without asking.
 * ========================================================================== */
import { useCallback, useEffect, useState } from "react";
import * as filesDb from "@/services/files/db";
import { unusedFileIds } from "@/services/files/sweep";
import { size } from "@/lib/files/limits";
import { useToast } from "@/context/ToastContext";
import Section from "../../Section";

export default function FilesSection() {
  const toast = useToast();
  const [info, setInfo] = useState<{ count: number; bytes: number; unused: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [all, unused] = await Promise.all([filesDb.list(), unusedFileIds()]);
    setInfo({ count: all.length, bytes: all.reduce((n, f) => n + f.size, 0), unused });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function removeUnused() {
    if (!info?.unused.length) return;
    setBusy(true);
    try {
      await filesDb.remove(info.unused);
      toast(`Removed ${info.unused.length} unused file${info.unused.length === 1 ? "" : "s"}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="data.files">
      <p className="sset-note">
        {!info
          ? "Counting…"
          : !info.count
            ? "No pictures or PDFs are kept yet."
            : `${info.count} file${info.count === 1 ? "" : "s"} kept, ${size(info.bytes)}. ` +
              (info.unused.length
                ? `${info.unused.length} of them are no longer used by any conversation.`
                : "Every one is still used by a conversation.")}
      </p>
      {!!info?.unused.length && (
        <div className="btnrow">
          <button className="btn sm" disabled={busy} onClick={() => void removeUnused()}>
            {busy ? "Removing…" : `Remove ${info.unused.length} unused`}
          </button>
        </div>
      )}
    </Section>
  );
}
