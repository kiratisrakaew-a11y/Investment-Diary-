import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";
import { checkApiKey } from "@/lib/auth";
import { createMcpServer } from "@/server/mcp";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Stateless Streamable HTTP MCP endpoint. Authenticate with
 * `Authorization: Bearer <API_KEY>` or, for clients that only accept a URL,
 * `?key=<API_KEY>` (keep that URL private).
 */
async function handle(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const authed = checkApiKey(req) || (key != null && checkApiKey(new Request(req.url, { headers: { authorization: `Bearer ${key}` } })));
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
