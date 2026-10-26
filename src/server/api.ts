import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ZodError } from "zod";
import { SESSION_COOKIE, checkApiKey, verifySessionToken } from "@/lib/auth";
import { LedgerError } from "@/lib/finance/portfolio";
import { OptimizerError } from "@/lib/finance/optimizer";

async function authorized(req: Request) {
  if (checkApiKey(req)) return true;
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export function errorResponse(e: unknown) {
  if (e instanceof ZodError) {
    return NextResponse.json({ error: "Invalid input", issues: e.issues }, { status: 400 });
  }
  if (e instanceof LedgerError) {
    return NextResponse.json({ error: e.message, code: e.issue.code, issue: e.issue }, { status: 400 });
  }
  if (e instanceof OptimizerError) {
    return NextResponse.json({ error: e.message, code: e.issue.code, suggestion: e.issue.suggestion }, { status: 400 });
  }
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Wrap a route handler with API-key / session auth and uniform error handling. */
export function api<C = unknown>(handler: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    if (!(await authorized(req))) {
      return NextResponse.json({ error: "Unauthorized — send Authorization: Bearer <API_KEY>" }, { status: 401 });
    }
    try {
      const result = await handler(req, ctx);
      return result instanceof Response ? result : NextResponse.json(result);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function jsonBody(req: Request) {
  try {
    return await req.json();
  } catch {
    throw new Error("Request body must be JSON");
  }
}

export function searchParams(req: Request) {
  return new URL(req.url).searchParams;
}
