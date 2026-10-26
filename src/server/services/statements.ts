/**
 * Financial statement uploads: read an Excel / CSV / PDF file with Claude,
 * extract up to five fiscal years of standard line items, and store them.
 * Uploaded files are processed in memory and never stored.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import ExcelJS from "exceljs";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  LINE_ITEMS,
  deriveRatios,
  emptyYear,
  extractionSchema,
  financialYearSchema,
  mergeYears,
  normalizeExtraction,
  type Extraction,
  type FinancialYear,
} from "@/lib/financials";
import { getAssetBySymbol } from "./assets";

export const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;
const MAX_SHEET_CHARS = 150_000;
const MODEL = process.env.ADVISOR_MODEL ?? "claude-opus-5-5";

export class UploadError extends Error {}

export type UploadKind = "pdf" | "xlsx" | "csv";

export function detectKind(filename: string, mime: string): UploadKind | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (ext === "xlsx" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (ext === "csv" || mime === "text/csv") return "csv";
  return null;
}

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

/** Every worksheet as CSV text, truncated so the request stays reasonable. */
export async function xlsxToText(bytes: ArrayBuffer): Promise<{ text: string; truncated: boolean }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const rows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map((c) => csvEscape(cellText(c).trim()));
      while (values.length && values[values.length - 1] === "") values.pop();
      if (values.length) rows.push(values.join(","));
    });
    if (rows.length) parts.push(`### Sheet: ${ws.name}\n${rows.join("\n")}`);
  });
  const text = parts.join("\n\n");
  return { text: text.slice(0, MAX_SHEET_CHARS), truncated: text.length > MAX_SHEET_CHARS };
}

const SYSTEM = `You extract historical financial statement data for equity valuation.
Rules:
- Prefer CONSOLIDATED statements (งบการเงินรวม). Use separate statements (งบเฉพาะกิจการ) only if no consolidated figures exist, and say so.
- Return every fiscal year present, including comparative columns (a statement usually shows the current and prior year).
- Convert Buddhist Era years to Gregorian (2567 → 2024).
- Copy numbers exactly as printed in the source unit; report the unit and the conversion factors. Do not do unit arithmetic yourself.
- Expenses, capex and dividends paid are positive numbers. Numbers in parentheses are negative unless they are expense lines.
- Total debt = all interest-bearing borrowings, debentures and lease liabilities (current + non-current).
- Use null for anything not present. Never estimate or invent a figure; computable totals (e.g. gross profit = revenue − cost of sales) are fine.
- In notes, cite the pages or sheets used and flag anything uncertain (restatements, discontinued operations, unusual items).`;

/** Ask Claude to read one file and return a structured extraction. */
export async function extractFromFile(file: { name: string; type: string; bytes: ArrayBuffer }): Promise<Extraction> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new UploadError("ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY — AI จึงอ่านไฟล์ไม่ได้ (กรอกตัวเลขในตารางเองได้)");
  }
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadError("ไฟล์ใหญ่เกิน 4.5MB — ตัดเฉพาะหน้างบการเงินแล้วอัปโหลดใหม่");
  const kind = detectKind(file.name, file.type);
  if (!kind) throw new UploadError("รองรับเฉพาะ PDF, Excel (.xlsx) และ CSV — ไฟล์ .xls ให้บันทึกเป็น .xlsx ก่อน");

  const instruction = `Extract the income statement, balance sheet and cash flow figures from "${file.name}" for every fiscal year it contains.`;
  let content: Anthropic.Beta.BetaContentBlockParam[];
  if (kind === "pdf") {
    content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(file.bytes).toString("base64") } },
      { type: "text", text: instruction },
    ];
  } else {
    const { text, truncated } =
      kind === "xlsx" ? await xlsxToText(file.bytes) : { text: new TextDecoder().decode(file.bytes).slice(0, MAX_SHEET_CHARS), truncated: false };
    if (!text.trim()) throw new UploadError("ไม่พบข้อมูลในไฟล์");
    content = [{ type: "text", text: `${instruction}${truncated ? " (The spreadsheet was truncated.)" : ""}\n\n<spreadsheet>\n${text}\n</spreadsheet>` }];
  }

  const client = new Anthropic();
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(extractionSchema) },
    // Re-run declined requests on a suitable fallback model instead of stopping.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new UploadError("AI ปฏิเสธการอ่านไฟล์นี้");
  if (res.stop_reason === "max_tokens") throw new UploadError("ข้อมูลยาวเกินไป — แยกไฟล์ให้เล็กลง");
  if (!res.parsed_output) throw new UploadError("AI อ่านข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
  return res.parsed_output;
}

// ------------------------------------------------------------------ storage

export async function getStatements(symbol: string): Promise<FinancialYear[]> {
  const rows = await getDb()
    .select()
    .from(schema.financialStatements)
    .where(eq(schema.financialStatements.symbol, symbol.toUpperCase()))
    .orderBy(asc(schema.financialStatements.fiscalYear));
  return rows.map((r) => ({ ...emptyYear(r.fiscalYear), ...(r.data as Partial<FinancialYear>), fiscalYear: r.fiscalYear }));
}

export async function getStatementsWithMeta(symbol: string) {
  const db = getDb();
  const [rows, uploads] = await Promise.all([
    db.select().from(schema.financialStatements).where(eq(schema.financialStatements.symbol, symbol.toUpperCase())).orderBy(asc(schema.financialStatements.fiscalYear)),
    db.select().from(schema.statementUploads).where(eq(schema.statementUploads.symbol, symbol.toUpperCase())).orderBy(asc(schema.statementUploads.createdAt)),
  ]);
  return {
    years: rows.map((r) => ({ ...emptyYear(r.fiscalYear), ...(r.data as Partial<FinancialYear>), fiscalYear: r.fiscalYear })),
    sources: Object.fromEntries(rows.map((r) => [r.fiscalYear, r.sourceFile])) as Record<number, string | null>,
    uploads,
  };
}

function dataOf(y: FinancialYear) {
  return Object.fromEntries(LINE_ITEMS.map((k) => [k, y[k]])) as Record<string, number | null>;
}

/** Upsert years for a symbol, merging with what is already stored. */
export async function saveYears(symbol: string, incoming: FinancialYear[], opts: { source?: string; currency?: string; preferIncoming?: boolean } = {}) {
  const sym = symbol.trim().toUpperCase();
  const parsed = incoming.map((y) => financialYearSchema.parse(y));
  const merged = mergeYears(await getStatements(sym), parsed, opts.preferIncoming ?? true);
  const touched = new Set(parsed.map((y) => y.fiscalYear));
  const asset = await getAssetBySymbol(sym);
  const db = getDb();
  for (const y of merged.filter((m) => touched.has(m.fiscalYear))) {
    const values = {
      symbol: sym,
      assetId: asset?.id ?? null,
      fiscalYear: y.fiscalYear,
      currency: opts.currency ?? "THB",
      data: dataOf(y),
      sourceFile: opts.source ?? null,
      updatedAt: new Date(),
    };
    await db
      .insert(schema.financialStatements)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.financialStatements.symbol, schema.financialStatements.fiscalYear],
        set: { data: values.data, currency: values.currency, updatedAt: values.updatedAt, ...(opts.source ? { sourceFile: opts.source } : {}) },
      });
  }
  return getStatements(sym);
}

export async function deleteYear(symbol: string, fiscalYear: number) {
  await getDb()
    .delete(schema.financialStatements)
    .where(and(eq(schema.financialStatements.symbol, symbol.toUpperCase()), eq(schema.financialStatements.fiscalYear, fiscalYear)));
}

/** Full pipeline for one uploaded file: extract → normalize to millions → merge & store → log. */
export async function processUpload(symbol: string, file: { name: string; type: string; bytes: ArrayBuffer }) {
  const sym = symbol.trim().toUpperCase();
  const db = getDb();
  try {
    const extraction = await extractFromFile(file);
    const years = normalizeExtraction(extraction).filter((y) => y.fiscalYear >= 1990 && y.fiscalYear <= 2100);
    if (!years.length) throw new UploadError("ไม่พบตัวเลขงบการเงินในไฟล์นี้");
    const all = await saveYears(sym, years, { source: file.name, currency: extraction.currency || "THB" });
    await db.insert(schema.statementUploads).values({
      symbol: sym,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.bytes.byteLength,
      status: "done",
      yearsFound: years.map((y) => y.fiscalYear),
      unitDetected: extraction.unitInSource,
      notes: `${extraction.statementBasis === "separate" ? "⚠️ ใช้งบเฉพาะกิจการ. " : ""}${extraction.notes}`,
    });
    return { ok: true as const, yearsFound: years.map((y) => y.fiscalYear), unit: extraction.unitInSource, basis: extraction.statementBasis, notes: extraction.notes, years: all };
  } catch (e) {
    const message = e instanceof UploadError ? e.message : `อ่านไฟล์ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`;
    await db.insert(schema.statementUploads).values({
      symbol: sym,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.bytes.byteLength,
      status: "error",
      error: message,
    });
    return { ok: false as const, error: message };
  }
}

/** History + ratios, for the AI advisor / MCP. */
export async function statementsSummary(symbol: string) {
  const years = await getStatements(symbol);
  return { symbol: symbol.toUpperCase(), unit: "millions (per-share items in currency units)", years, ratios: deriveRatios(years) };
}
