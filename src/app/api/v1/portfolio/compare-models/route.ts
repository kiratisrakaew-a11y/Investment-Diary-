import { api, jsonBody } from "@/server/api";
import { comparePortfolioModels } from "@/server/services/model-comparison";

export const maxDuration = 60;

export const POST = api(async (req) => comparePortfolioModels((await jsonBody(req)) as never));
