import { NextResponse } from "next/server";
import { MODEL_VERSION } from "@/lib/governance";
import { mcpToolNames, serverVersion } from "@/server/mcp";

/** Public build info (no portfolio data): which commit is live and which MCP tools it has. */
export async function GET() {
  return NextResponse.json({
    version: serverVersion(),
    modelVersion: MODEL_VERSION,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    environment: process.env.VERCEL_ENV ?? "local",
    mcpTools: mcpToolNames(),
  });
}
