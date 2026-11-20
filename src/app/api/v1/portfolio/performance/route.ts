import { api, searchParams } from "@/server/api";
import { getPerformance } from "@/server/services/portfolio";
import { benchmarkField, returnBasisField } from "@/server/basis-schema";

export const GET = api(async (req) => {
  const q = searchParams(req);
  const { growth: _g, valueSeries: _v, ...metrics } = await getPerformance(undefined, undefined, {
    returnBasis: returnBasisField.parse(q.get("returnBasis") ?? undefined),
    benchmark: benchmarkField.parse(q.get("benchmark") ?? undefined),
  });
  return metrics;
});
