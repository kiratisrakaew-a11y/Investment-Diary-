import { api, jsonBody } from "@/server/api";
import { getTimestampPolicy, saveTimestampPolicy } from "@/server/services/settings";

export const GET = api(async () => ({ timestampPolicy: await getTimestampPolicy() }));
/** Body: { inputsMaxAgeDays?, priceMaxGapDays?, statementsMaxAgeDays? } (days; missing = keep). */
export const PUT = api(async (req) => ({ timestampPolicy: await saveTimestampPolicy((await jsonBody(req)) as never) }));
