import type { Note } from "@/db/schema";
import { saveNoteAction } from "@/app/(app)/actions";
import { today } from "@/lib/validation";
import { ActionForm } from "./ActionForm";

export function NoteForm({ note, symbols }: { note?: Note; symbols?: string[] }) {
  return (
    <ActionForm action={saveNoteAction} className="space-y-3" resetOnSuccess={!note}>
      {note && <input type="hidden" name="id" value={note.id} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label">วันที่</label>
          <input name="date" type="date" className="input" defaultValue={note?.date ?? today()} />
        </div>
        <div>
          <label className="label">ประเภท</label>
          <select name="type" className="input" defaultValue={note?.type ?? "idea"}>
            <option value="idea">ไอเดีย</option>
            <option value="thesis">Thesis</option>
            <option value="review">ทบทวน</option>
            <option value="lesson">บทเรียน</option>
            <option value="market">มุมมองตลาด</option>
          </select>
        </div>
        <div>
          <label className="label">ความมั่นใจ (1-5)</label>
          <input name="conviction" type="number" min={1} max={5} className="input" defaultValue={note?.conviction ?? ""} />
        </div>
        <div>
          <label className="label">สินทรัพย์ (คั่นด้วย ,)</label>
          <input name="symbols" className="input" placeholder="PTT, AAPL" defaultValue={symbols?.join(", ")} />
        </div>
      </div>
      <div>
        <label className="label">หัวข้อ</label>
        <input name="title" className="input" required defaultValue={note?.title} />
      </div>
      <div>
        <label className="label">รายละเอียด (Markdown) — เหตุผล, ตัวเร่ง, ความเสี่ยง, มูลค่า, แผนออก</label>
        <textarea name="body" rows={6} className="input font-mono" defaultValue={note?.body} />
      </div>
      <div>
        <label className="label">แท็ก (คั่นด้วย ,)</label>
        <input name="tags" className="input" placeholder="dividend, value" defaultValue={note?.tags.join(", ")} />
      </div>
    </ActionForm>
  );
}
