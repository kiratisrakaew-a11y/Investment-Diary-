import { api, searchParams } from "@/server/api";
import { getRiskFree } from "@/server/services/risk-free";

/** GET ?currency=THB&horizonYears=1&purpose=portfolio&source=auto — rate with provenance and warnings. */
export const GET = api(async (req) => {
  const q = searchParams(req);
  const n = (k: string) => (q.get(k) != null ? Number(q.get(k)) : undefined);
  return getRiskFree({
    currency: q.get("currency") ?? undefined,
    asOf: q.get("asOf") ?? undefined,
    horizonYears: n("horizonYears"),
    purpose: (q.get("purpose") as "portfolio" | "dcf" | "bond_spread" | null) ?? undefined,
    source: (q.get("source") as "auto" | "curve" | "settings" | null) ?? undefined,
  });
});
