import { z } from "zod";
import { api, jsonBody } from "@/server/api";
import { assetDependencies, changeAssetLifecycle } from "@/server/services/asset-lifecycle";

type Ctx = { params: Promise<{ id: string }> };

const body = z.object({
  action: z.enum(["hide", "unhide", "archive", "unarchive", "delete"]),
  confirmSymbol: z.string().optional().describe("delete: the asset's exact symbol"),
});

/** GET: dependency counts (what blocks a permanent delete). */
export const GET = api<Ctx>(async (_req, { params }) => {
  const id = Number((await params).id);
  const deps = await assetDependencies(id);
  return deps ? { assetId: id, dependencies: deps } : Response.json({ status: "NOT_FOUND" }, { status: 404 });
});

/** POST { action, confirmSymbol? } → typed status (HIDDEN / ARCHIVED / RESTORED / DELETED / BLOCKED_HAS_DEPENDENCIES / FORBIDDEN / NOT_FOUND). */
export const POST = api<Ctx>(async (req, { params }) => {
  const id = Number((await params).id);
  const b = body.parse(await jsonBody(req));
  const r = await changeAssetLifecycle({ assetId: id, action: b.action, confirmSymbol: b.confirmSymbol, source: "api" });
  const http = r.status === "NOT_FOUND" ? 404 : r.status === "FORBIDDEN" ? 403 : r.status === "BLOCKED_HAS_DEPENDENCIES" ? 409 : 200;
  return Response.json(r, { status: http });
});
