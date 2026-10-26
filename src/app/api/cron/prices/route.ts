import { NextResponse } from "next/server";
import { checkApiKey, safeEqual } from "@/lib/auth";
import { updateAllPrices } from "@/server/services/price-updater";

export const maxDuration = 60;

/** Called daily by Vercel Cron (Authorization: Bearer CRON_SECRET) or manually with the API key. */
export async function GET(req: Request) {
  const cron = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const ok = (cron && safeEqual(auth, `Bearer ${cron}`)) || checkApiKey(req);
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ results: await updateAllPrices() });
}
