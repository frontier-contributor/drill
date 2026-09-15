/* ============================================================================
 * sheet.ts — an Excel workbook, every sheet, as CSV the model can read.
 *
 * read-excel-file rather than SheetJS: the SheetJS build on the npm registry
 * stopped at 0.18.5, which carries CVE-2023-30533 (prototype pollution from a
 * crafted file), and the maintained build is only published off-registry. A
 * spreadsheet someone emailed you is exactly the crafted-file case.
 * ========================================================================== */
import { cellText, describeTable } from "@/lib/files/csv";
import { MAX_TABLE_ROWS } from "@/lib/files/limits";

export async function readXlsx(file: Blob): Promise<{ text: string; sheets: number; truncated: boolean }> {
  const { default: readXlsxFile } = await import("read-excel-file/browser");
  let sheets: unknown[];
  try {
    sheets = await readXlsxFile(file);
  } catch (e) {
    throw new Error(
      `This Excel file could not be read — it may be damaged, password-protected, or not really an .xlsx. (${(e as Error)?.message || "unknown error"})`
    );
  }
  const parts: string[] = [];
  let truncated = false;
  for (const raw of sheets) {
    const s = raw as { sheet?: string; data?: unknown[][] };
    const title = `Sheet "${s.sheet ?? parts.length + 1}"`;
    const rows = (s.data || []).map((r) => (Array.isArray(r) ? r.map(cellText) : []));
    if (!rows.length) {
      parts.push(`${title} is empty.`);
      continue;
    }
    const t = describeTable(title, rows, rows.length, MAX_TABLE_ROWS);
    truncated ||= t.truncated;
    parts.push(t.text);
  }
  return { text: parts.join("\n\n"), sheets: sheets.length, truncated };
}
