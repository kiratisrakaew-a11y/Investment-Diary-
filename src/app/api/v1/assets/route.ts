import { api, jsonBody } from "@/server/api";
import { createAsset, listAssets } from "@/server/services/assets";

export const GET = api(async () => listAssets());
export const POST = api(async (req) => createAsset(await jsonBody(req)));
