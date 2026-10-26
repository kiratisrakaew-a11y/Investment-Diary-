import { api, jsonBody } from "@/server/api";
import { recordPrice } from "@/server/services/prices";

export const POST = api(async (req) => recordPrice(await jsonBody(req)));
