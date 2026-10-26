import { NextResponse } from "next/server";
import { z } from "zod";
import { api, jsonBody } from "@/server/api";
import { AdvisorNotConfigured } from "@/server/advisor";
import { sendToAdvisor } from "@/server/services/advisor-threads";

export const runtime = "nodejs";
// Tool-using answers can take a while; Vercel caps this by plan.
export const maxDuration = 300;

const body = z.object({ threadId: z.number().int().nullable().optional(), message: z.string().min(1).max(8000) });

export const POST = api(async (req) => {
  const { threadId, message } = body.parse(await jsonBody(req));
  try {
    return await sendToAdvisor(threadId ?? null, message);
  } catch (e) {
    if (e instanceof AdvisorNotConfigured) return NextResponse.json({ error: e.message }, { status: 503 });
    throw e;
  }
});
