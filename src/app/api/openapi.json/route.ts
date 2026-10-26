import { NextResponse } from "next/server";
import { buildOpenApi } from "@/server/openapi";

export function GET(req: Request) {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return NextResponse.json(buildOpenApi(`${proto}://${host}`));
}
