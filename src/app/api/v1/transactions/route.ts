import { api, jsonBody, searchParams } from "@/server/api";
import { createTransaction, listTransactions } from "@/server/services/transactions";
import { getAssetBySymbol } from "@/server/services/assets";

export const GET = api(async (req) => {
  const p = searchParams(req);
  const symbol = p.get("symbol");
  const asset = symbol ? await getAssetBySymbol(symbol) : null;
  const rows = await listTransactions({ assetId: asset?.id, limit: Number(p.get("limit") ?? 100) });
  return rows.map((r) => ({ ...r.tx, symbol: r.symbol, currency: r.currency }));
});

export const POST = api(async (req) => createTransaction({ source: "api", ...(await jsonBody(req)) }));
