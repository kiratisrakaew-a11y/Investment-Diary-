import { z } from "zod";
import { api, searchParams } from "@/server/api";
import { deleteEvent } from "@/server/services/stock-data";

type Ctx = { params: Promise<{ id: string }> };
const q = z.object({
  symbol: z.string().trim().min(1).max(40),
  confirmDelete: z.literal("true"),
});

/** DELETE ?symbol=PLANB&confirmDelete=true — removes one recorded event. */
export const DELETE = api<Ctx>(async (req, { params }) => {
  const x = q.parse(Object.fromEntries(searchParams(req)));
  return deleteEvent(Number((await params).id), x.symbol);
});
