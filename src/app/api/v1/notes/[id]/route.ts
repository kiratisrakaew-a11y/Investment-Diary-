import { api, jsonBody } from "@/server/api";
import { getNote, updateNote } from "@/server/services/notes";

type Ctx = { params: Promise<{ id: string }> };

export const GET = api<Ctx>(async (_req, { params }) => {
  const note = await getNote(Number((await params).id));
  if (!note) throw new Error("Note not found");
  return note;
});

export const PATCH = api<Ctx>(async (req, { params }) => updateNote(Number((await params).id), await jsonBody(req)));
