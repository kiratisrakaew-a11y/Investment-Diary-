import { api, jsonBody } from "@/server/api";
import { getYieldCurve, saveYieldCurve } from "@/server/services/settings";

export const GET = api(async () => ({ yieldCurve: await getYieldCurve() }));
/** Body: { points: [{years, rate}], source, asOf } or { clear: true }. */
export const PUT = api(async (req) => {
  const body = (await jsonBody(req)) as { clear?: boolean };
  return { yieldCurve: await saveYieldCurve(body.clear ? null : (body as never)) };
});
