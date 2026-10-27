import { ASSET_CLASS_COLOR, ASSET_CLASS_LABEL, fmtPctRaw, fmtThb, signClass } from "@/lib/format";
import type { AllocationRow } from "@/lib/finance/allocation";

export function AllocationTable({ rows }: { rows: AllocationRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>ประเภท</th>
            <th className="num">มูลค่า</th>
            <th className="num">จริง</th>
            <th className="min-w-40">จริง vs เป้า</th>
            <th className="num">เป้า</th>
            <th className="num">ส่วนต่าง</th>
            <th className="num">ปรับสมดุล</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.assetClass}>
              <td>
                <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: ASSET_CLASS_COLOR[r.assetClass] }} />
                {ASSET_CLASS_LABEL[r.assetClass]}
              </td>
              <td className="num">{fmtThb(r.value)}</td>
              <td className="num">{fmtPctRaw(r.actualPct)}</td>
              <td>
                {/* Bar = actual share; tick = target. */}
                <div className="relative h-2 rounded-full bg-panel-2">
                  <div className="h-2 rounded-full" style={{ width: `${Math.min(100, r.actualPct)}%`, background: ASSET_CLASS_COLOR[r.assetClass] }} />
                  <div className="absolute -top-1 h-4 w-0.5 rounded bg-text/70" style={{ left: `calc(${Math.min(100, r.targetPct)}% - 1px)` }} title={`เป้า ${fmtPctRaw(r.targetPct)}`} />
                </div>
              </td>
              <td className="num">{fmtPctRaw(r.targetPct)}</td>
              <td className={`num ${Math.abs(r.driftPct) > 5 ? signClass(r.driftPct) : ""}`}>
                {r.driftPct > 0 ? "+" : ""}
                {fmtPctRaw(r.driftPct)}
              </td>
              <td className="num text-xs">
                {Math.abs(r.rebalanceAmount) < 1 ? "–" : `${r.rebalanceAmount > 0 ? "ซื้อ" : "ขาย"} ${fmtThb(Math.abs(r.rebalanceAmount))}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
