/* ============================================================================
 * csv.ts — tables, from CSV files and from spreadsheets, as a model reads them.
 *
 * A table goes to the model as CSV rather than as a markdown table: the same
 * rows in markdown cost roughly twice the tokens in pipes and padding, and
 * every model reads CSV fluently. The one thing added is a sentence in front
 * saying how big the table really is, because a model shown five hundred rows
 * of a five-thousand-row file will otherwise compute an average over what it
 * was shown and call it the answer.
 *
 * Pure. Spreadsheets arrive here as rows already (services/files/sheet.ts).
 * ========================================================================== */
import { commas } from "./limits";

export type Delimiter = "," | "\t" | ";" | "|";

const CANDIDATES: Delimiter[] = [",", "\t", ";", "|"];

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === d && !inQuotes) n++;
  }
  return n;
}

/**
 * The separator a file actually uses. Semicolons are what a spreadsheet in a
 * decimal-comma locale exports; a CSV parsed on commas there is one column of
 * everything. The winner is the candidate that appears most, and most
 * consistently, across the first lines.
 */
export function sniffDelimiter(sample: string, name = ""): Delimiter {
  if (/\.tsv$/i.test(name)) return "\t";
  const lines = stripBom(sample)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 20);
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const first = counts[0] || 0;
    if (!first) continue;
    const consistency = counts.filter((c) => c === first).length / counts.length;
    const score = first * consistency;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180, as it is actually written: quoted cells may hold the separator, a
 *  doubled quote is a quote, and lines end however the exporting OS ends them.
 *  Blank lines are skipped. `keep` bounds what is held; `total` counts all. */
export function parseDelimited(text: string, delimiter: Delimiter, keep = Infinity): { rows: string[][]; total: number } {
  const s = stripBom(text);
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.length > 1 || row[0] !== "") {
      total++;
      if (rows.length < keep) rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return { rows, total };
}

export function toDelimited(rows: string[][], delimiter: Delimiter = ","): string {
  return rows
    .map((r) =>
      r.map((c) => (c.includes(delimiter) || /["\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(delimiter)
    )
    .join("\n");
}

/** A spreadsheet cell as text. A date with no time of day is a date, not
 *  midnight in UTC — which is how a birthday becomes the day before. */
export function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const iso = v.toISOString();
    return v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? iso : iso.slice(0, 10);
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v);
}

export interface TableText {
  text: string;
  truncated: boolean;
  columns: number;
}

/** "results.csv — 5,432 rows × 12 columns, the first 500 shown below." and then
 *  the rows, as CSV. `total` counts every row, header included. */
export function describeTable(title: string, rows: string[][], total: number, maxRows: number): TableText {
  const shown = rows.slice(0, maxRows);
  const columns = shown.reduce((n, r) => Math.max(n, r.length), 0);
  const truncated = total > shown.length;
  const head =
    `${title} — ${commas(total)} row${total === 1 ? "" : "s"} × ${columns} column${columns === 1 ? "" : "s"}` +
    (truncated ? `, the first ${commas(shown.length)} shown below` : "") +
    ".";
  return { text: `${head}\n\n${toDelimited(shown)}`, truncated, columns };
}
