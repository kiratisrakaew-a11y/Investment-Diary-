/**
 * Parse price tables pasted or uploaded by the user (CSV text, or a worksheet converted to CSV).
 * Formats are detected from the header row:
 * - long:   symbol, date, close[, adj close]
 * - wide:   date, SYM1, SYM2, …            (one column per symbol)
 * - single: date, [open, high, low,] close[, adj close, volume]  (one symbol; e.g. a Yahoo/Investing export)
 * Dates may be ISO, day-first (Thai), Buddhist-era years, Excel serial numbers or month names.
 */

export interface ImportRow {
  symbol: string;
  date: string;
  close: number;
  adjClose: number | null;
}

export interface ParseResult {
  format: "long" | "wide" | "single" | null;
  rows: ImportRow[];
  errors: { line: number; reason: string }[];
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6, "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (y > 2400) y -= 543; // Buddhist era
  if (y < 100) y += 2000;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Date text → YYYY-MM-DD, or null when it is not a real date. Numeric day/month order is day-first. */
export function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/^"|"$/g, "");
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{5})(?:\.0+)?$/);
  if (m) {
    const n = +m[1];
    if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  // "Jan 05, 2026" / "05-Jan-2026" / "5 ม.ค. 2569"
  m = s.match(/^([A-Za-zก-๙.]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = s.match(/^(\d{1,2})[-\s]([A-Za-zก-๙.]+)[-\s](\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/^"|"$/g, "").replace(/[,\s฿$]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Minimal CSV line splitter with quoted fields. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === "," || ch === "\t" || ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const norm = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").trim();
const DATE_KEYS = ["date", "วันที่", "วัน", "trade date", "as of"];
const SYMBOL_KEYS = ["symbol", "ticker", "สัญลักษณ์", "หุ้น", "หลักทรัพย์", "asset", "code"];
const CLOSE_KEYS = ["close", "price", "nav", "ราคา", "ราคาปิด", "ปิด", "close price", "last", "ราคาล่าสุด"];
const ADJ_KEYS = ["adj close", "adjclose", "adjusted close", "adj. close", "ราคาปรับ"];
const OTHER_KEYS = ["open", "high", "low", "volume", "vol", "change", "change %", "change%", "ราคาเปิด", "สูงสุด", "ต่ำสุด", "ปริมาณ"];
const has = (keys: string[], h: string) => keys.includes(norm(h));

export function parsePriceTable(text: string, opts: { symbol?: string } = {}): ParseResult {
  const lines = text.split(/\r?\n/);
  const errors: ParseResult["errors"] = [];
  const rows: ImportRow[] = [];

  // Header = first line (within the first 30) that has a date column.
  let headerIdx = -1;
  let header: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (!lines[i].trim() || lines[i].startsWith("### ")) continue;
    const cells = splitCsv(lines[i]);
    if (cells.some((c) => has(DATE_KEYS, c))) {
      headerIdx = i;
      header = cells;
      break;
    }
  }
  if (headerIdx < 0) {
    return { format: null, rows, errors: [{ line: 1, reason: "ไม่พบหัวตาราง — ต้องมีคอลัมน์วันที่ (date / วันที่) และราคา (close / ราคาปิด) หรือคอลัมน์ละหุ้น" }] };
  }

  const dateCol = header.findIndex((h) => has(DATE_KEYS, h));
  const symCol = header.findIndex((h) => has(SYMBOL_KEYS, h));
  const closeCol = header.findIndex((h) => has(CLOSE_KEYS, h));
  const adjCol = header.findIndex((h) => has(ADJ_KEYS, h));
  const format: ParseResult["format"] = symCol >= 0 && closeCol >= 0 ? "long" : closeCol >= 0 ? "single" : "wide";
  const fixedSymbol = opts.symbol?.trim().toUpperCase();
  if (format === "single" && !fixedSymbol) {
    return { format, rows, errors: [{ line: headerIdx + 1, reason: "ไฟล์นี้เป็นราคาของหุ้นตัวเดียว — ระบุ symbol ของสินทรัพย์ด้วย" }] };
  }
  const wideCols = header
    .map((h, i) => ({ h: h.trim(), i }))
    .filter(({ h, i }) => i !== dateCol && h && !has(OTHER_KEYS, h) && !has(ADJ_KEYS, h) && !has(SYMBOL_KEYS, h));
  if (format === "wide" && !wideCols.length) {
    return { format: null, rows, errors: [{ line: headerIdx + 1, reason: "ไม่พบหัวตาราง — มีคอลัมน์วันที่แต่ไม่มีคอลัมน์ราคา" }] };
  }

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const lineNo = i + 1;
    if (!lines[i].trim() || lines[i].startsWith("### ")) continue;
    const c = splitCsv(lines[i]);
    const date = parseDate(c[dateCol] ?? "");
    if (!date) {
      errors.push({ line: lineNo, reason: `วันที่ไม่ถูกต้อง: "${c[dateCol] ?? ""}"` });
      continue;
    }
    const push = (symbol: string, closeRaw: string | undefined, adjRaw?: string) => {
      const close = parseNumber(closeRaw ?? "");
      if (close == null) return format === "wide" ? undefined : errors.push({ line: lineNo, reason: "ไม่มีราคา" });
      if (!(close > 0)) return errors.push({ line: lineNo, reason: `ราคาไม่ถูกต้อง: "${closeRaw}"` });
      const adj = adjRaw != null ? parseNumber(adjRaw) : null;
      rows.push({ symbol, date, close, adjClose: adj != null && adj > 0 ? adj : null });
    };
    if (format === "long") {
      const sym = (c[symCol] ?? "").trim().toUpperCase();
      if (!sym) {
        errors.push({ line: lineNo, reason: "ไม่มี symbol" });
        continue;
      }
      push(sym, c[closeCol], adjCol >= 0 ? c[adjCol] : undefined);
    } else if (format === "single") push(fixedSymbol!, c[closeCol], adjCol >= 0 ? c[adjCol] : undefined);
    else for (const w of wideCols) push(w.h.toUpperCase(), c[w.i]);
  }
  return { format, rows, errors };
}
