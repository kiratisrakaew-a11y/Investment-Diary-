import { api, jsonBody } from "@/server/api";
import { refreshConsensusFromYahoo } from "@/server/services/consensus";

export const maxDuration = 30;

/** POST { symbol } → fetch from Yahoo now; NO_COVERAGE / FETCH_FAILED write nothing and return the latest found. */
export const POST = api(async (req) => {
  const b = (await jsonBody(req)) as { symbol?: unknown };
  return refreshConsensusFromYahoo(typeof b.symbol === "string" ? b.symbol : "");
});
