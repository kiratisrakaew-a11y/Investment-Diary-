import { api, jsonBody, searchParams } from "@/server/api";
import { createNote, listNotes } from "@/server/services/notes";
import { getAssetBySymbol } from "@/server/services/assets";

export const GET = api(async (req) => {
  const p = searchParams(req);
  const symbol = p.get("symbol");
  const asset = symbol ? await getAssetBySymbol(symbol) : null;
  return listNotes({
    q: p.get("q") ?? undefined,
    type: p.get("type") ?? undefined,
    tag: p.get("tag") ?? undefined,
    assetId: asset?.id,
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
    limit: p.get("limit") ? Number(p.get("limit")) : 50,
  });
});

export const POST = api(async (req) => {
  const body = await jsonBody(req);
  return createNote({ source: "api", ...body });
});
