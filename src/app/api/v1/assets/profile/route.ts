import { api, jsonBody } from "@/server/api";
import { updateAssetProfile } from "@/server/services/assets";

/** Update issuer / sector / credit metadata of an asset (no prices or transactions touched). */
export const POST = api(async (req) => updateAssetProfile((await jsonBody(req)) as never));
