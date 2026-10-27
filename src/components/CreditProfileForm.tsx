"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Profile = {
  rating?: string;
  ratingAgency?: string;
  ratingDate?: string;
  seniority?: string;
  pd?: { type: string; source: string; asOf: string; annual?: number; cumulative?: { years: number; pd: number }[] };
  lgd?: { value: number; source: string; asOf: string };
};

const pctText = (v?: number) => (v == null ? "" : String(+(v * 100).toFixed(4)));

/** Edit a bond's issuer and credit profile. Every number needs a source and date; nothing is defaulted. */
export function CreditProfileForm({ symbol, issuer, profile, today }: { symbol: string; issuer: string | null; profile: Profile | null; today: string }) {
  const router = useRouter();
  const p = profile ?? {};
  const [f, setF] = useState({
    issuer: issuer ?? "",
    rating: p.rating ?? "",
    ratingAgency: p.ratingAgency ?? "",
    ratingDate: p.ratingDate ?? "",
    seniority: p.seniority ?? "",
    pdType: p.pd?.type ?? "hypothetical",
    pdSource: p.pd?.source ?? "",
    pdAsOf: p.pd?.asOf ?? today,
    pdMode: p.pd?.cumulative?.length ? "cumulative" : "annual",
    pdAnnual: pctText(p.pd?.annual),
    pdCurve: (p.pd?.cumulative ?? []).map((c) => `${c.years}:${+(c.pd * 100).toFixed(4)}`).join(", "),
    lgd: pctText(p.lgd?.value),
    lgdSource: p.lgd?.source ?? "",
    lgdAsOf: p.lgd?.asOf ?? today,
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save(clearCredit = false) {
    setPending(true);
    setMsg(null);
    try {
      const hasPd = f.pdMode === "annual" ? f.pdAnnual.trim() !== "" : f.pdCurve.trim() !== "";
      const credit = clearCredit
        ? null
        : {
            ...(f.rating ? { rating: f.rating, ratingAgency: f.ratingAgency || undefined, ratingDate: f.ratingDate || undefined } : {}),
            ...(f.seniority ? { seniority: f.seniority } : {}),
            ...(hasPd
              ? {
                  pd: {
                    type: f.pdType,
                    source: f.pdSource,
                    asOf: f.pdAsOf,
                    ...(f.pdMode === "annual"
                      ? { annual: Number(f.pdAnnual) / 100 }
                      : {
                          cumulative: f.pdCurve
                            .split(",")
                            .map((x) => x.split(":").map((y) => Number(y.trim())))
                            .filter((x) => x.length === 2 && x.every(Number.isFinite))
                            .map(([years, pd]) => ({ years, pd: pd / 100 })),
                        }),
                  },
                }
              : {}),
            ...(f.lgd.trim() !== "" ? { lgd: { value: Number(f.lgd) / 100, source: f.lgdSource, asOf: f.lgdAsOf } } : {}),
          };
      const r = await fetch("/api/v1/assets/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol, issuer: f.issuer.trim() || null, credit }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? data.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join(", ") ?? `HTTP ${r.status}`);
      setMsg({ ok: true, text: "บันทึกแล้ว" });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(false);
    }
  }

  const input = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" value={f[k]} onChange={set(k)} {...props} />
    </label>
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-4">
        {input("issuer", "ผู้ออก (issuer)", { placeholder: "เช่น CPF" })}
        {input("rating", "อันดับเครดิต", { placeholder: "เว้นว่าง = unrated" })}
        {input("ratingAgency", "สถาบันจัดอันดับ", { placeholder: "เช่น TRIS" })}
        {input("ratingDate", "วันที่จัดอันดับ", { type: "date" })}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="label">ประเภท PD</span>
          <select className="input" value={f.pdType} onChange={set("pdType")}>
            <option value="hypothetical">สมมติฐาน (scenario)</option>
            <option value="historical">สถิติในอดีต (default study)</option>
            <option value="market_implied">จากราคาตลาด (ระบุแบบจำลอง)</option>
          </select>
        </label>
        {input("pdSource", "ที่มา PD (จำเป็น)", { placeholder: "เช่น S&P default study 2025, BBB" })}
        {input("pdAsOf", "PD ณ วันที่", { type: "date" })}
        <label className="block">
          <span className="label">รูปแบบ PD</span>
          <select className="input" value={f.pdMode} onChange={set("pdMode")}>
            <option value="annual">PD ต่อปีคงที่</option>
            <option value="cumulative">PD สะสมตามช่วงเวลา</option>
          </select>
        </label>
        {f.pdMode === "annual" ? input("pdAnnual", "PD ต่อปี (%)", { inputMode: "decimal" }) : <div className="sm:col-span-2">{input("pdCurve", "PD สะสม (ปี:% , …)", { placeholder: "1:0.2, 3:0.9, 5:1.8" })}</div>}
        {input("lgd", "LGD (%)", { inputMode: "decimal", placeholder: "เช่น 60" })}
        {input("lgdSource", "ที่มา LGD (จำเป็น)")}
        {input("lgdAsOf", "LGD ณ วันที่", { type: "date" })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" disabled={pending} onClick={() => save()}>
          {pending ? "กำลังบันทึก…" : "บันทึกข้อมูลเครดิต"}
        </button>
        <button type="button" className="btn-ghost text-xs" disabled={pending} onClick={() => save(true)}>
          ล้างข้อมูลเครดิต
        </button>
        {msg && <span className={msg.ok ? "text-pos" : "text-neg"}>{msg.text}</span>}
      </div>
      <p className="text-xs text-muted">ระบบไม่เดา PD / LGD / อันดับเครดิต — ถ้าไม่กรอก ผลจะเป็น &quot;ไม่มีข้อมูล&quot; ไม่ใช่ความเสี่ยงศูนย์ · ห้ามแปลง credit spread เป็น PD โดยตรง</p>
    </div>
  );
}
