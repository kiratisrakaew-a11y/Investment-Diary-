import { NextResponse } from "next/server";
import { api, jsonBody } from "@/server/api";
import { AdvisorNotConfigured } from "@/server/advisor";
import { explainValues } from "@/server/explain";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Plain-language AI explanation of the values a page section shows. */
export const POST = api(async (req) => {
  try {
    return await explainValues(await jsonBody(req));
  } catch (e) {
    if (e instanceof AdvisorNotConfigured) return NextResponse.json({ error: e.message }, { status: 503 });
    throw e;
  }
});
