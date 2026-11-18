import { api, searchParams } from "@/server/api";
import { abnormalOverview } from "@/server/services/abnormal";
import { rangeQuery, thresholdsOf } from "@/app/api/v1/abnormal/params";

type Ctx = { params: Promise<{ id: string }> };

/** GET ?from=&to=&notable=&abnormal= — daily scan of one Thai stock with every day, events and share counts (for the asset page). */
export const GET = api<Ctx>(async (req, { params }) => {
  const q = rangeQuery.parse(Object.fromEntries(searchParams(req)));
  return abnormalOverview(Number((await params).id), {
    from: q.from,
    to: q.to,
    thresholds: thresholdsOf(q),
  });
});
