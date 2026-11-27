"use client";

/**
 * Analyst consensus on the stock valuation page: latest target found (any source), upside vs the last
 * stored close, age and caveats, a Yahoo refresh button, manual entry and a short history.
 * Other people's opinion — shown beside the user's valuations, never averaged into them.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { deleteConsensusAction, refreshConsensusAction, saveConsensusAction } from "@/app/(app)/valuation/actions";
import { CONSENSUS_SOURCE_LABEL, RECOMMENDATIONS, RECOMMENDATION_LABEL, type ConsensusView, type Recommendation } from "@/lib/consensus";
import { fmtNum, fmtPct, signClass } from "@/lib/format";
import { Modal } from "./AssetMetricForm";

export interface ConsensusRowLite {
  id: number;
  asOf: string;
  source: string;
  sourceNote: string | null;
  currency: string | null;
  targetMean: number | null;
  targetMedian: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  analysts: number | null;
  recommendationKey: string | null;
  note: string | null;
}

const recLabel = (k: string | null) => (k && k in RECOMMENDATION_LABEL ? RECOMMENDATION_LABEL[k as Recommendation] : null);

export function ConsensusCard({ symbol, latest, view, history, price, priceDate, today }: { symbol: string; latest: ConsensusRowLite | null; view: ConsensusView | null; history: ConsensusRowLite[]; price: number | null; priceDate: string | null; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = () =>
    start(async () => {
      const r = await refreshConsensusAction(symbol);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  const remove = (id: number) =>
    start(async () => {
      if (!confirm("ลบรายการนี้ถาวร?")) return;
      const r = await deleteConsensusAction(id, symbol);
      setMsg(r.ok ? { ok: true, text: "ลบแล้ว" } : { ok: false, text: r.error });
      router.refresh();
    });

  return (
    <section className="card space-y-3" aria-labelledby="consensus-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="consensus-title" className="text-base font-semibold">
            ราคาเป้าหมายนักวิเคราะห์ (Consensus)
          </h2>
          <p className="text-xs text-text-muted">ความเห็นของนักวิเคราะห์ ไม่ใช่การประเมินของคุณ — แสดงแยก ไม่นำไปเฉลี่ยกับ valuation ในแอป</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={refresh} disabled={pending}>
            {pending ? "กำลังดึง…" : "ดึงจาก Yahoo"}
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setOpen(true)} disabled={pending}>
            กรอกเอง
          </button>
        </div>
      </div>
      {msg && (
        <p role="status" className={clsx("text-xs", msg.ok ? "text-positive" : "text-warning")}>
          {msg.text}
        </p>
      )}

      {latest && view ? (
        <>
          <dl className="flex flex-wrap gap-x-12 gap-y-3">
            <div>
              <dt className="text-xs text-text-muted">เป้าหมาย{view.targetBasis === "mean" ? "เฉลี่ย" : "มัธยฐาน"}</dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {fmtNum(view.target)} {latest.currency && <span className="text-xs font-normal text-text-muted">{latest.currency}</span>}
              </dd>
              {latest.targetMean != null && latest.targetMedian != null && <dd className="text-xs text-text-muted">มัธยฐาน {fmtNum(latest.targetMedian)}</dd>}
            </div>
            <div>
              <dt className="text-xs text-text-muted">ช่วงเป้าหมาย</dt>
              <dd className="text-2xl font-semibold tabular-nums">{latest.targetLow != null && latest.targetHigh != null ? `${fmtNum(latest.targetLow)} – ${fmtNum(latest.targetHigh)}` : "—"}</dd>
              <dd className="text-xs text-text-muted">
                {latest.analysts != null ? `${latest.analysts} นักวิเคราะห์` : "ไม่ระบุจำนวนนักวิเคราะห์"}
                {recLabel(latest.recommendationKey) && ` · คำแนะนำ: ${recLabel(latest.recommendationKey)}`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Upside จากราคาล่าสุด</dt>
              <dd className={clsx("text-2xl font-semibold tabular-nums", signClass(view.upside))}>{fmtPct(view.upside, 1)}</dd>
              <dd className="text-xs text-text-muted">{price != null ? `เทียบ ${fmtNum(price)}${priceDate ? ` ณ ${priceDate}` : ""}` : "ไม่มีราคาในระบบ"}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">ที่มา</dt>
              <dd className="text-sm font-medium">{CONSENSUS_SOURCE_LABEL[latest.source] ?? latest.source}</dd>
              <dd className="text-xs text-text-muted">
                ณ {latest.asOf} · {view.ageDays === 0 ? "วันนี้" : `${view.ageDays} วันก่อน`}
                {latest.sourceNote && latest.source !== "yahoo" ? ` · ${latest.sourceNote}` : ""}
              </dd>
            </div>
          </dl>
          {view.warnings.map((w) => (
            <p key={w} className="text-xs text-warning">
              ⚠ {w}
            </p>
          ))}
        </>
      ) : (
        <p className="text-sm text-text-muted">ยังไม่มีข้อมูล consensus ของ {symbol} — กด “ดึงจาก Yahoo” หรือ “กรอกเอง” จากบทวิเคราะห์ที่อ้างอิงได้</p>
      )}

      {history.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-text-muted">ประวัติ ({history.length})</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="table min-w-[560px] text-xs">
              <thead>
                <tr>
                  <th>ณ วันที่</th>
                  <th>ที่มา</th>
                  <th className="num">เฉลี่ย</th>
                  <th className="num">มัธยฐาน</th>
                  <th className="num">ต่ำ – สูง</th>
                  <th className="num">นักวิเคราะห์</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.asOf}</td>
                    <td title={h.note ?? undefined}>
                      {CONSENSUS_SOURCE_LABEL[h.source] ?? h.source}
                      {h.sourceNote && h.source !== "yahoo" && <span className="text-text-muted"> · {h.sourceNote}</span>}
                    </td>
                    <td className="num">{fmtNum(h.targetMean)}</td>
                    <td className="num">{fmtNum(h.targetMedian)}</td>
                    <td className="num">{h.targetLow != null && h.targetHigh != null ? `${fmtNum(h.targetLow)} – ${fmtNum(h.targetHigh)}` : "—"}</td>
                    <td className="num">{h.analysts ?? "—"}</td>
                    <td className="text-right">
                      <button type="button" className="text-negative hover:underline" onClick={() => remove(h.id)} disabled={pending}>
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p className="text-xs text-text-muted">Yahoo Finance เป็นแหล่งข้อมูลไม่เป็นทางการ หุ้นไทยหลายตัวอาจไม่มีข้อมูลหรือไม่ทันสมัย · ถ้า Yahoo ไม่มีข้อมูล ระบบจะไม่ลบของเดิม และยังแสดงชุดล่าสุดที่เคยพบ</p>

      <Modal open={open} onClose={() => setOpen(false)} title={`กรอก consensus ของ ${symbol}`}>
        <ConsensusForm
          symbol={symbol}
          today={today}
          currency={latest?.currency ?? null}
          onDone={(text) => {
            setOpen(false);
            setMsg({ ok: true, text });
            router.refresh();
          }}
        />
      </Modal>
    </section>
  );
}

function ConsensusForm({ symbol, today, currency, onDone }: { symbol: string; today: string; currency: string | null; onDone: (msg: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const num = (f: FormData, k: string) => {
    const v = String(f.get(k) ?? "").trim().replace(/,/g, "");
    return v === "" ? undefined : Number(v);
  };
  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block">
      <span className="label">{label}</span>
      <input name={name} className="input" {...props} />
    </label>
  );
  return (
    <form
      className="grid grid-cols-2 gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const rec = String(f.get("recommendationKey") ?? "");
          const r = await saveConsensusAction({
            symbol,
            asOf: String(f.get("asOf") ?? ""),
            sourceNote: String(f.get("sourceNote") ?? ""),
            currency: String(f.get("currency") ?? "").trim() || undefined,
            targetMean: num(f, "targetMean"),
            targetMedian: num(f, "targetMedian"),
            targetLow: num(f, "targetLow"),
            targetHigh: num(f, "targetHigh"),
            analysts: num(f, "analysts"),
            recommendationKey: rec ? (rec as Recommendation) : undefined,
            note: String(f.get("note") ?? "").trim() || undefined,
          });
          if (r.ok) onDone("บันทึก consensus แล้ว");
          else setError(r.error);
        });
      }}
    >
      <div className="col-span-2">{field("sourceNote", "แหล่งที่มา *", { required: true, maxLength: 200, placeholder: "เช่น บล.xxx / SET consensus" })}</div>
      {field("asOf", "ณ วันที่ของข้อมูล *", { type: "date", required: true, max: today, defaultValue: today })}
      {field("currency", "สกุลเงิน", { maxLength: 3, defaultValue: currency ?? "", placeholder: "THB" })}
      {field("targetMean", "เป้าหมายเฉลี่ย", { inputMode: "decimal" })}
      {field("targetMedian", "เป้าหมายมัธยฐาน", { inputMode: "decimal" })}
      {field("targetLow", "ต่ำสุด", { inputMode: "decimal" })}
      {field("targetHigh", "สูงสุด", { inputMode: "decimal" })}
      {field("analysts", "จำนวนนักวิเคราะห์", { inputMode: "numeric" })}
      <label className="block">
        <span className="label">คำแนะนำ</span>
        <select name="recommendationKey" className="input" defaultValue="">
          <option value="">ไม่ระบุ</option>
          {RECOMMENDATIONS.map((k) => (
            <option key={k} value={k}>
              {RECOMMENDATION_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <div className="col-span-2">{field("note", "หมายเหตุ", { maxLength: 500 })}</div>
      <p className="col-span-2 text-xs text-text-muted">ต้องมีเป้าหมายเฉลี่ยหรือมัธยฐานอย่างน้อยหนึ่งค่า · กรอกเฉพาะตัวเลขที่มีในรายงาน ช่องที่ไม่รู้ให้เว้นว่าง · วันที่เดียวกันจะแทนที่รายการเดิม</p>
      {error && (
        <p role="alert" className="col-span-2 text-xs text-negative">
          {error}
        </p>
      )}
      <div className="col-span-2 flex justify-end">
        <button className="btn" disabled={pending}>
          {pending ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </form>
  );
}
