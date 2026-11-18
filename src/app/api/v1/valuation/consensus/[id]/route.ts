import { api } from "@/server/api";
import { deleteConsensus } from "@/server/services/consensus";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = api<Ctx>(async (_req, { params }) => deleteConsensus(Number((await params).id)));
