"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { NumField, SelectField, Toggle } from "./fields";
import { fmtNum, fmtPct, fmtThb } from "@/lib/format";
import type { RebalanceResult } from "@/lib/finance/rebalance";
import { ExplainButton } from "./ExplainButton";
import { compact } from "@/lib/explain-data";

type Objective = "track" | "after_cost" | "min_cost" | "min_turnover";
type Response = RebalanceResult & { disclaimer: string; costModel: { commissionPct: number; minCommission: number; vatPct: number; slippageBps: number; sellTaxPct: number } };

/** Optimizer weights → editable targets → whole-lot trade proposal (never recorded). */
export function RebalancePanel({ suggested, extraCash, sourceLabel = "optimizer" }: { suggested: { symbol: string; weight: number }[]; extraCash: number; sourceLabel?: string }) {
  const fromOptimizer = () => Object.fromEntries(suggested.map((s) => [s.symbol, s.weight]));
  const [weights, setWeights] = useState<Record<string, number | null>>(fromOptimizer);
  const [edited, setEdited] = useState(false);
  const [objective, setObjective] = useState<Objective>("track");
  const [band, setBand] = useState(0);
  const [reserve, setReserve] = useState(0);
  const [maxTurnover, setMaxTurnover] = useState<number | null>(null);
  const [allowSell, setAllowSell] = useState(true);
  const [res, setRes] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = suggested.map((s) => `${s.symbol}:${s.weight.toFixed(6)}`).join();

  // Follow the optimizer until the user edits a weight.
  useEffect(() => {
    if (!edited) setWeights(fromOptimizer());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const sum = Object.values(weights).reduce<number>((a, b) => a + (b ?? 0), 0);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const targets = Object.fromEntries(Object.entries(weights).filter((e): e is [string, number] => e[1] != null));
      const r = await fetch("/api/v1/portfolio/rebalance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets, objective, extraCash, cashReserve: reserve, noTradeBand: band, allowSell, ...(maxTurnover != null ? { maxTurnover } : {}) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setRes(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRes(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">แปลงเป็นคำสั่งซื้อขาย (Rebalance)</h2>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => {
            setWeights(fromOptimizer());
            setEdited(false);
          }}
        >
          ↺ ใช้น้ำหนักจาก {sourceLabel}
        </button>
      </div>
      <p className="text-xs text-muted">
        น้ำหนักเริ่มจากผล {sourceLabel} — แก้ได้ทุกช่อง (เป็น % ของ มูลค่าสินทรัพย์ + เงินสด + เงินเพิ่ม − เงินสำรอง) · ส่วนที่เหลือคงเป็นเงินสด · สินทรัพย์ที่ถือแต่ไม่อยู่ในตารางจะคงไว้ ·
        ใช้ต้นทุนจากหน้าตั้งค่า
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <table className="table">
            <thead>
              <tr>
                <th>สินทรัพย์</th>
                <th className="num">{sourceLabel}</th>
                <th className="num w-28">เป้าหมาย (%)</th>
              </tr>
            </thead>
            <tbody>
              {suggested.map((s) => (
                <tr key={s.symbol}>
                  <td className="font-medium">{s.symbol}</td>
                  <td className="num text-muted">{fmtPct(s.weight, 1)}</td>
                  <td className="num">
                    <PctCell
                      value={weights[s.symbol] ?? null}
                      onChange={(v) => {
                        setEdited(true);
                        setWeights((w) => ({ ...w, [s.symbol]: v }));
                      }}
                    />
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td>รวม / เงินสด</td>
                <td />
                <td className={clsx("num", sum > 1 + 1e-9 && "text-neg")}>
                  {fmtPct(sum, 1)} / {fmtPct(Math.max(0, 1 - sum), 1)}
                </td>
              </tr>
            </tbody>
          </table>
          {edited && <p className="mt-1 text-xs text-accent">แก้น้ำหนักเองแล้ว (ไม่ตาม {sourceLabel})</p>}
        </div>
        <div className="space-y-3 lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField
              label="เป้าหมายการปรับ"
              value={objective}
              options={[
                { value: "track", label: "ใกล้เป้าหมายที่สุด" },
                { value: "after_cost", label: "ใกล้เป้าหมาย หักต้นทุน" },
                { value: "min_cost", label: "เน้นต้นทุนต่ำ" },
                { value: "min_turnover", label: "เน้นซื้อขายน้อย" },
              ]}
              onChange={setObjective}
            />
            <NumField label="ไม่ปรับถ้าห่างเป้าไม่เกิน" pct value={band} onChange={(v) => setBand(Math.max(0, v ?? 0))} />
            <NumField label="เงินสดสำรอง (บาท)" value={reserve} onChange={(v) => setReserve(Math.max(0, v ?? 0))} />
            <NumField label="Turnover สูงสุด" pct nullable value={maxTurnover} onChange={setMaxTurnover} />
            <div className="flex items-end sm:col-span-2">
              <Toggle label="ขายได้ (ถ้าปิด = ใช้เงินสดซื้ออย่างเดียว)" checked={allowSell} onChange={setAllowSell} />
            </div>
          </div>
          <button type="button" className="btn" onClick={run} disabled={pending || sum > 1 + 1e-9}>
            {pending ? "กำลังคำนวณ…" : "คำนวณคำสั่งซื้อขาย"}
          </button>
          {error && <p className="text-sm text-neg">{error}</p>}
        </div>
      </div>

      {res && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <ExplainButton
              topic="ข้อเสนอการปรับพอร์ต (Rebalance)"
              label="อธิบายข้อเสนอนี้"
              data={compact({ คำสั่ง: res.trades, รวม: res.totals, เงินสด: res.cash, มูลค่าพอร์ต: res.total, ระยะห่างจากเป้า: res.distance, ข้อจำกัดที่ละเมิด: res.violations, คำเตือน: res.warnings, ต้นทุน: res.costModel })}
              hint="เป็นข้อเสนอเท่านั้น ไม่ได้บันทึกรายการจริง; ต้นทุนรวมค่าคอม VAT slippage"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>สินทรัพย์</th>
                  <th>คำสั่ง</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ราคา</th>
                  <th className="num">มูลค่า</th>
                  <th className="num">ต้นทุน</th>
                  <th className="num">น้ำหนัก ก่อน → หลัง (เป้า)</th>
                  <th>หมายเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {res.trades.map((t) => (
                  <tr key={t.symbol}>
                    <td className="font-medium">{t.symbol}</td>
                    <td className={clsx(t.side === "buy" ? "text-pos" : t.side === "sell" ? "text-neg" : "text-muted")}>{t.side === "buy" ? "ซื้อ" : t.side === "sell" ? "ขาย" : "–"}</td>
                    <td className="num">{t.side === "hold" ? "–" : fmtNum(t.quantity, t.quantity % 1 ? 4 : 0)}</td>
                    <td className="num">{fmtNum(t.price)}</td>
                    <td className="num">{t.side === "hold" ? "–" : fmtThb(t.value)}</td>
                    <td className="num">{t.cost.total ? fmtNum(t.cost.total) : "–"}</td>
                    <td className="num">
                      {fmtPct(t.currentWeight, 1)} → {fmtPct(t.finalWeight, 1)} ({t.targetWeight != null ? fmtPct(t.targetWeight, 1) : "คงไว้"})
                    </td>
                    <td className="text-xs text-muted">{t.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-x-6 text-sm sm:grid-cols-3">
            <KV k="ซื้อ / ขาย" v={`${fmtThb(res.totals.buy)} / ${fmtThb(res.totals.sell)}`} />
            <KV k="ต้นทุนรวม" v={fmtThb(res.totals.cost)} />
            <KV k="Turnover" v={fmtPct(res.totals.turnoverPct, 1)} />
            <KV k="เงินสดก่อน → หลัง" v={`${fmtThb(res.cash.start + res.cash.extra)} → ${fmtThb(res.cash.end)}`} />
            <KV k={res.distance.measure === "tracking_error" ? "Tracking error ก่อน → หลัง" : "ห่างจากเป้า (น้ำหนัก) ก่อน → หลัง"} v={`${fmtPct(res.distance.before, 2)} → ${fmtPct(res.distance.after, 2)}`} />
            <KV k="ถ้าซื้อเศษหุ้นได้ (ไม่มี lot)" v={fmtPct(res.distance.continuousIdeal, 2)} />
          </div>
          {res.violations.map((v) => (
            <p key={v} className="text-sm text-neg">✕ {v}</p>
          ))}
          {res.warnings.map((w) => (
            <p key={w} className="text-xs text-muted">⚠️ {w}</p>
          ))}
          <p className="text-xs font-medium text-neg">{res.disclaimer}</p>
        </div>
      )}
    </section>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1.5">
      <span className="text-muted">{k}</span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}

function PctCell({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const fmt = (v: number | null) => (v == null ? "" : String(+(v * 100).toFixed(2)));
  const [text, setText] = useState(fmt(value));
  useEffect(() => {
    const n = Number(text);
    if (value == null ? text !== "" : !Number.isFinite(n) || Math.abs(n / 100 - value) > 1e-6) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="input w-20 text-right tabular-nums"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === "") return onChange(null);
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n >= 0) onChange(n / 100);
      }}
    />
  );
}
