import { api, jsonBody } from "@/server/api";
import { stressTestPortfolio } from "@/server/services/stress";

export const POST = api(async (req) => stressTestPortfolio((await jsonBody(req)) as never));
