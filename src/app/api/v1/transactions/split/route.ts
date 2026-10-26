import { api, jsonBody } from "@/server/api";
import { recordSplit } from "@/server/services/splits";

/** Record a stock split / reverse split (dryRun previews) and repair stored prices. */
export const POST = api(async (req) => recordSplit({ source: "api", ...((await jsonBody(req)) as object) } as never));
