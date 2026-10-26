import { api } from "@/server/api";
import { getMptAnalysis } from "@/server/services/portfolio";

export const GET = api(async () => {
  const r = await getMptAnalysis();
  if (!r.ok) return r;
  const { cloud: _c, frontier: _f, ...rest } = r;
  return rest;
});
