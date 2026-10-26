import { NextResponse } from "next/server";

/** Example CSV for bulk price import (long format; wide and one-symbol exports are also accepted). */
export async function GET() {
  const csv = "symbol,date,close\nPTT,2026-01-05,34.50\nPTT,2026-01-06,34.75\nBBL,2026-01-05,150.00\nBBL,2026-01-06,151.50\n";
  return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="price-import-template.csv"' } });
}
