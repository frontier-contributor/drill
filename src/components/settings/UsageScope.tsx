/* ============================================================================
 * UsageScope — the token and cost console.
 *
 * Reads services/usageLog, which is written from the single seam in
 * services/ai's chat(). Because every feature goes through that seam, this
 * shows card writing, journal, distill, rollups, exam generation and grading
 * alongside chat — the first time any of them have been visible.
 *
 * Two groupings of the same rows: by model (what is expensive) and by
 * feature (what is spending it). The second is usually the interesting one.
 *
 * The run transcript is the same ledger read the other way — what the call
 * actually said, rather than what it cost — so it is the second group on this
 * page rather than a row in a menu somewhere.
 * ========================================================================== */
import { useState } from "react";
import * as usageLog from "@/services/usageLog";
import type { UsageRow } from "@/services/usageLog";
import { formatCost, formatTokens } from "@/lib/tokens";
import { useStoreSync } from "@/hooks/useStoreSync";
import Section from "./Section";
import RunTranscript from "./sections/usage/RunTranscript";

const RANGES: [number, string][] = [
  [1, "Today"],
  [7, "7 days"],
  [30, "30 days"],
  [0, "All"]
];

/** A row's share of the largest row in its group, for the inline bar. Cost
 *  where anything is priced, tokens otherwise — a bar drawn on unknown cost
 *  would rank every unpriced model at zero. */
function shareOf(r: UsageRow, max: number, priced: boolean): number {
  const v = priced ? r.cost || 0 : volume(r);
  return max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
}

/** "42s", "3m 10s" — speech transcribed in voice mode. */
function secondsLabel(s: number): string {
  const n = Math.round(s);
  return n < 60 ? n + "s" : Math.floor(n / 60) + "m " + (n % 60) + "s";
}

/** How much a row did, for the bar when nothing is priced. A voice reports
 *  characters and no tokens and an image model reports barely any tokens at
 *  all; counting only tokens would draw both of those at nothing. Pictures are
 *  weighted so one is visible beside a few thousand tokens rather than being a
 *  rounding error on the same axis. */
function volume(r: UsageRow): number {
  return r.promptTokens + r.completionTokens + (r.characters || 0) + (r.images || 0) * 1000 + (r.seconds || 0) * 15;
}

function Group({ title, sub, rows, name }: { title: string; sub: string; rows: UsageRow[]; name: (r: UsageRow) => string }) {
  const priced = rows.some((r) => r.cost != null);
  const max = Math.max(...rows.map((r) => (priced ? r.cost || 0 : volume(r))), 0);

  return (
    <>
      <div className="srow">
        <span className="grow">
          <span className="t">{title}</span>
          <span className="s">{sub}</span>
        </span>
      </div>
      <div className="usage-rows">
        {rows.map((r) => (
          <div key={name(r) + r.backend} className="usage-row">
            <div className="usage-head">
              <span className="usage-name">{name(r)}</span>
              <span className="usage-cost">{formatCost(r.cost)}</span>
            </div>
            <div className="usage-bar" aria-hidden="true">
              <i style={{ width: shareOf(r, max, priced) + "%" }} />
            </div>
            <div className="usage-meta">
              {r.calls} {r.calls === 1 ? "call" : "calls"}
              {r.errors > 0 ? ` · ${r.errors} failed` : ""}
              {/* A voice bills by the character and reports no tokens, and
                  "0 in · 0 out" under it would read like a fault. */}
              {r.promptTokens || r.completionTokens || !(r.characters || r.images || r.seconds)
                ? ` · ${formatTokens(r.promptTokens)} in · ${formatTokens(r.completionTokens)} out`
                : ""}
              {r.characters > 0 ? ` · ${formatTokens(r.characters)} characters read aloud` : ""}
              {r.images > 0 ? ` · ${r.images} picture${r.images === 1 ? "" : "s"}` : ""}
              {r.seconds > 0 ? ` · ${secondsLabel(r.seconds)} heard` : ""}
              {r.cachedPromptTokens > 0 ? ` · ${formatTokens(r.cachedPromptTokens)} cached` : ""}
              {r.reasoningTokens > 0 ? ` · ${formatTokens(r.reasoningTokens)} reasoning` : ""}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export default function UsageScope() {
  useStoreSync(usageLog);
  const [days, setDays] = useState(7);
  const [confirming, setConfirming] = useState(false);

  const span = usageLog.range(days);
  const totals = usageLog.totals(span);
  const byModel = usageLog.rollup(span, (r) => r.backend + "|" + r.model);
  const byFeature = usageLog.rollup(span, (r) => r.label);

  return (
    <>
    <Section id="usage.cost">
      <div className="seg">
        {RANGES.map(([v, label]) => (
          <button key={v} className={days === v ? "on" : ""} onClick={() => setDays(v)}>
            {label}
          </button>
        ))}
      </div>

      {totals.calls === 0 ? (
        <div className="empty">
          Nothing spent in this window. Every call — chat, cards, journal, distill, exam, listening — is counted here from now on.
        </div>
      ) : (
        <>
          <div className="usage-total">
            <span className="usage-total-cost">{formatCost(totals.cost)}</span>
            <span className="usage-total-sub">
              {totals.calls} {totals.calls === 1 ? "call" : "calls"}
              {totals.errors > 0 ? ` · ${totals.errors} failed` : ""} · {formatTokens(totals.promptTokens)} in ·{" "}
              {formatTokens(totals.completionTokens)} out
              {totals.cachedPromptTokens > 0 ? ` · ${formatTokens(totals.cachedPromptTokens)} of the input cached` : ""}
              {totals.characters > 0 ? ` · ${formatTokens(totals.characters)} characters read aloud` : ""}
              {totals.images > 0 ? ` · ${totals.images} picture${totals.images === 1 ? "" : "s"} drawn` : ""}
              {totals.seconds > 0 ? ` · ${secondsLabel(totals.seconds)} of speech heard` : ""}
            </span>
          </div>

          {totals.unpriced.length > 0 && (
            <div className="hintline">
              No published price for {totals.unpriced.join(", ")} — those calls are counted in the token totals but not in the money. A blank
              cost is unknown, not free.
            </div>
          )}

          <Group title="By feature" sub="What is doing the spending." rows={byFeature} name={(r) => r.label} />
          <Group title="By model" sub="What each model costs you." rows={byModel} name={(r) => r.model} />

          <div className="btnrow usage-clear">
            {confirming ? (
              <>
                <button
                  className="btn sm danger"
                  onClick={() => {
                    void usageLog.clear();
                    setConfirming(false);
                  }}
                >
                  Delete all history
                </button>
                <button className="btn sm" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn sm" onClick={() => setConfirming(true)}>
                Clear usage history
              </button>
            )}
          </div>
        </>
      )}
    </Section>

    <RunTranscript />
    </>
  );
}
