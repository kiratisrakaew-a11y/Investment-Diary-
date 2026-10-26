import ExcelJS from "exceljs";

/** Spreadsheet helpers shared by statement and price uploads. */

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v && v.result != null) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("error" in v) return "";
  }
  return String(v);
}

const csvEscape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Every non-empty worksheet as CSV text (dates as YYYY-MM-DD). */
export async function workbookToCsv(bytes: ArrayBuffer): Promise<{ name: string; csv: string }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const out: { name: string; csv: string }[] = [];
  wb.eachSheet((ws) => {
    const rows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map((c) => csvEscape(cellText(c).trim()));
      while (values.length && values[values.length - 1] === "") values.pop();
      if (values.length) rows.push(values.join(","));
    });
    if (rows.length) out.push({ name: ws.name, csv: rows.join("\n") });
  });
  return out;
}
