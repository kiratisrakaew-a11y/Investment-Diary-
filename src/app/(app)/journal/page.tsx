import Link from "next/link";
import { listNotes, allTags } from "@/server/services/notes";
import { listAssets } from "@/server/services/assets";
import { listTransactions } from "@/server/services/transactions";
import { NoteCard } from "@/components/NoteCard";
import { NoteForm } from "@/components/NoteForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Empty, PageHeader } from "@/components/ui";
import { deleteNoteAction } from "../actions";
import { TX_TYPE_LABEL, fmtNum, fmtQty } from "@/lib/format";

type SP = Promise<{ q?: string; type?: string; tag?: string; source?: string; symbol?: string }>;

export default async function JournalPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const assets = await listAssets();
  const assetBySymbol = new Map(assets.map((a) => [a.symbol, a]));
  const symbolById = new Map(assets.map((a) => [a.id, a.symbol]));
  const [notes, tags, txs] = await Promise.all([
    listNotes({ q: sp.q, type: sp.type, tag: sp.tag, source: sp.source, assetId: sp.symbol ? assetBySymbol.get(sp.symbol)?.id : undefined }),
    allTags(),
    listTransactions({ limit: 2000 }),
  ]);
  const txByNote = new Map<number, typeof txs>();
  for (const t of txs) if (t.tx.noteId) txByNote.set(t.tx.noteId, [...(txByNote.get(t.tx.noteId) ?? []), t]);

  // Group by month for the timeline.
  const groups = new Map<string, typeof notes>();
  for (const n of notes) {
    const k = n.date.slice(0, 7);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }

  return (
    <>
      <PageHeader title="บันทึกการลงทุน" subtitle="Timeline ของไอเดีย, thesis, การทบทวน และบทเรียน" />

      <details className="card">
        <summary className="cursor-pointer font-medium">+ เขียนบันทึกใหม่</summary>
        <div className="mt-4">
          <NoteForm />
        </div>
      </details>

      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={sp.q} placeholder="ค้นหา…" className="input max-w-56" />
        <select name="type" defaultValue={sp.type ?? ""} className="input max-w-36">
          <option value="">ทุกประเภท</option>
          <option value="idea">ไอเดีย</option>
          <option value="thesis">Thesis</option>
          <option value="review">ทบทวน</option>
          <option value="lesson">บทเรียน</option>
          <option value="market">ตลาด</option>
        </select>
        <select name="symbol" defaultValue={sp.symbol ?? ""} className="input max-w-36">
          <option value="">ทุกสินทรัพย์</option>
          {assets.map((a) => (
            <option key={a.id}>{a.symbol}</option>
          ))}
        </select>
        <select name="tag" defaultValue={sp.tag ?? ""} className="input max-w-36">
          <option value="">ทุกแท็ก</option>
          {tags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select name="source" defaultValue={sp.source ?? ""} className="input max-w-36">
          <option value="">ทุกแหล่ง</option>
          <option value="web">เว็บ</option>
          <option value="claude">Claude</option>
          <option value="chatgpt">ChatGPT</option>
          <option value="api">API</option>
        </select>
        <button className="btn-ghost">กรอง</button>
        {Object.values(sp).some(Boolean) && (
          <Link href="/journal" className="self-center text-xs text-muted">ล้าง</Link>
        )}
      </form>

      {notes.length === 0 && <Empty>ไม่พบบันทึก</Empty>}

      <div className="space-y-8">
        {[...groups].map(([month, items]) => (
          <section key={month}>
            <h2 className="mb-3 text-sm font-semibold text-muted">
              {new Date(`${month}-01`).toLocaleDateString("th-TH", { month: "long", year: "numeric" })}
            </h2>
            <ol className="relative space-y-4 border-l border-border pl-6">
              {items.map((n) => {
                const linked = txByNote.get(n.id) ?? [];
                const syms = n.assetIds.map((id) => symbolById.get(id)).filter((s): s is string => !!s);
                return (
                  <li key={n.id} className="card relative">
                    <span className="absolute top-5 -left-[31px] h-3 w-3 rounded-full border-2 border-panel bg-accent" />
                    <NoteCard
                      note={n}
                      symbols={syms}
                      footer={
                        <>
                          {linked.length > 0 && (
                            <ul className="mt-3 space-y-1 rounded-lg bg-bg p-2 text-xs">
                              {linked.map((t) => (
                                <li key={t.tx.id}>
                                  🔗 {t.tx.date} {TX_TYPE_LABEL[t.tx.type]} {t.symbol} {t.tx.quantity ? `${fmtQty(t.tx.quantity)} @ ` : ""}
                                  {fmtNum(t.tx.price)} {t.currency}
                                </li>
                              ))}
                            </ul>
                          )}
                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs text-muted">แก้ไข</summary>
                            <div className="mt-3">
                              <NoteForm note={n} symbols={syms} />
                            </div>
                            <div className="mt-2 text-right">
                              <ConfirmButton onConfirm={deleteNoteAction.bind(null, n.id)} label="ลบบันทึกนี้" />
                            </div>
                          </details>
                        </>
                      }
                    />
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}
