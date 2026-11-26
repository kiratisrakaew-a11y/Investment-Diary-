/** spec-lookback-window: per-asset coverage of the chosen period (first price, periods, status). */
export function CoverageTable({
  rows,
}: {
  rows?: { symbol: string; firstDate: string | null; observations: number; status: "ok" | "limits_window" | "dropped"; reason?: string }[] | null;
}) {
  if (!rows?.length) return null;
  const label = { ok: "ใช้ได้", limits_window: "ทำให้ช่วงสั้นลง", dropped: "ไม่ได้ใช้" } as const;
  const tone = { ok: "text-pos", limits_window: "text-warn", dropped: "text-neg" } as const;
  return (
    <details className="text-xs" data-testid="coverage-panel" open={rows.some((r) => r.status !== "ok")}>
      <summary className="cursor-pointer text-muted">ข้อมูลรายสินทรัพย์ในช่วงนี้ ({rows.length} ตัว)</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1">สินทรัพย์</th>
              <th>ราคาวันแรก</th>
              <th className="text-right">งวดในช่วง</th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-t border-border">
                <td className="py-1 font-medium">{r.symbol}</td>
                <td className="tabular-nums">{r.firstDate ?? "–"}</td>
                <td className="text-right tabular-nums">{r.observations}</td>
                <td className={tone[r.status]} title={r.reason}>
                  {label[r.status]}
                  {r.reason && r.status === "dropped" ? <span className="block text-muted">{r.reason}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
