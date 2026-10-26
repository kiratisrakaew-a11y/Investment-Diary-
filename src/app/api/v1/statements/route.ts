import { z } from "zod";
import { api, jsonBody, searchParams } from "@/server/api";
import { emptyYear, financialYearSchema } from "@/lib/financials";
import { saveYears, statementsSummary } from "@/server/services/statements";

export const GET = api(async (req) => {
  const symbol = searchParams(req).get("symbol");
  if (!symbol) throw new Error("symbol is required");
  return statementsSummary(symbol);
});

const body = z.object({ symbol: z.string(), currency: z.string().optional(), years: z.array(financialYearSchema.partial().extend({ fiscalYear: z.number().int() })) });

export const POST = api(async (req) => {
  const b = body.parse(await jsonBody(req));
  return saveYears(b.symbol, b.years.map((y) => ({ ...emptyYear(y.fiscalYear), ...y })), { source: "api", currency: b.currency });
});
