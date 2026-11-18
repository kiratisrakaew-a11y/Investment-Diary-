import { api, jsonBody, searchParams } from "@/server/api";
import { consensusSummary, recordConsensus } from "@/server/services/consensus";

/** GET ?symbols=PTT,BBL[&history=1] → latest analyst consensus found per symbol (read-only). */
export const GET = api(async (req) => {
  const p = searchParams(req);
  const symbols = (p.get("symbols") ?? p.get("symbol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) throw new Error("ต้องระบุ symbols เช่น ?symbols=PTT,BBL");
  const history = p.get("history") === "1" || p.get("history") === "true";
  return { results: await Promise.all(symbols.slice(0, 30).map((s) => consensusSummary(s, { history }))) };
});

/** POST a consensus from a cited report (stored with source "mcp" = recorded by an AI / API client). */
export const POST = api(async (req) => recordConsensus((await jsonBody(req)) as never, "mcp"));
