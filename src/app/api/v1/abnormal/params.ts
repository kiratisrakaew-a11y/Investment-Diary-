/** Query-string parsing shared by the abnormal-trading REST routes (same validation as the MCP tools). */
import { z } from "zod";
import { isCalendarDate } from "@/lib/finance/abnormal/scan";

export const date = z
  .string()
  .refine(isCalendarDate, "วันที่ต้องเป็น YYYY-MM-DD ที่มีจริง");
const num = z.coerce.number().positive();
const win = z
  .string()
  .regex(/^-?\d+,-?\d+$/, "window = start,end เช่น -250,-30")
  .transform((v) => v.split(",").map(Number) as [number, number]);

export const rangeQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  notable: num.optional(),
  abnormal: num.optional(),
  estimationWindow: win.optional(),
});

export function thresholdsOf(q: { notable?: number; abnormal?: number }) {
  const t: { notable?: number; abnormal?: number } = {};
  if (q.notable != null) t.notable = q.notable;
  if (q.abnormal != null) t.abnormal = q.abnormal;
  return t;
}

export { win as windowParam };
