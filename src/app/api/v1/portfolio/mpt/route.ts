import { api, searchParams } from "@/server/api";
import { getMptAnalysis } from "@/server/services/portfolio";
import { returnBasisField } from "@/server/basis-schema";

export const GET = api(async (req) => {
  const returnBasis = returnBasisField.parse(searchParams(req).get("returnBasis") ?? undefined);
  const r = await getMptAnalysis(undefined, undefined, { returnBasis });
  if (!r.ok) return r;
  const { cloud: _c, frontier: _f, ...rest } = r;
  return rest;
});
