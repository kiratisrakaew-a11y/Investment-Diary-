import { api, jsonBody } from "@/server/api";
import { planBondLadder } from "@/server/services/bonds";

/** Forward bond-ladder plan (proposal only). */
export const POST = api(async (req) => planBondLadder(await jsonBody(req)));
