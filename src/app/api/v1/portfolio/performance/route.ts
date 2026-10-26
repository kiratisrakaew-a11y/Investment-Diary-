import { api } from "@/server/api";
import { getPerformance } from "@/server/services/portfolio";

export const GET = api(async () => {
  const { growth: _g, valueSeries: _v, ...metrics } = await getPerformance();
  return metrics;
});
