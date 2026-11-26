"use client";

import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { formatChange, formatNumber, formatPercent } from "@/lib/format";
import { Badge, Card, Collapsible, EmptyState, ErrorState, KpiCard, PageHeader, Section, Skeleton } from "./ui";
import { CHART, ChartContainer, DataTable, Tabs, type Column } from "./ui-client";

interface Row {
  symbol: string;
  price: number;
  fv: number | null;
  upside: number | null;
  status: "green" | "yellow" | "red";
}
const ROWS: Row[] = [
  { symbol: "PTT", price: 34.25, fv: 41.5, upside: 0.2117, status: "green" },
  { symbol: "CPALL", price: 58.0, fv: 52.75, upside: -0.0905, status: "yellow" },
  { symbol: "AAPL", price: 231.4, fv: null, upside: null, status: "red" },
  { symbol: "DOHOME", price: 9.1, fv: 9.15, upside: 0.0055, status: "green" },
];
const COLS: Column<Row>[] = [
  { key: "symbol", header: "สินทรัพย์", render: (r) => <span className="font-medium">{r.symbol}</span>, sortValue: (r) => r.symbol },
  { key: "price", header: "ราคา", unit: "บาท", numeric: true, render: (r) => formatNumber(r.price, 2), sortValue: (r) => r.price },
  { key: "fv", header: "FV Base", unit: "บาท", numeric: true, render: (r) => formatNumber(r.fv, 2), sortValue: (r) => r.fv },
  {
    key: "upside",
    header: "Upside",
    numeric: true,
    render: (r) => {
      const c = formatChange(r.upside);
      return <span className={c.className}>{c.text}</span>;
    },
    sortValue: (r) => r.upside,
  },
  { key: "status", header: "สถานะ", render: (r) => <Badge status={r.status}>{r.status.toUpperCase()}</Badge>, sortValue: (r) => r.status },
];
const SERIES = Array.from({ length: 24 }, (_, i) => ({ m: `M${i + 1}`, a: 100 + i * 2 + Math.sin(i / 2) * 6, b: 100 + i * 1.2 }));

export function DesignShowcase() {
  return (
    <div className="space-y-6">
      <PageHeader title="Design system" subtitle="ส่วนประกอบกลาง — ตัวอย่างการใช้งาน" action={<button className="btn">ปุ่มหลัก</button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="ราคา" value={formatNumber(34.25, 2)} change={0.0123} changeLabel="วันนี้" />
        <KpiCard label="FV Base" value={formatNumber(41.5, 2)} note="จาก 3 โมเดล" />
        <KpiCard label="Upside" value={formatPercent(0.2117)} change={-0.034} changeLabel="เทียบเดือนก่อน" />
        <KpiCard label="ROIC − WACC" value="—" note="ยังไม่มีข้อมูล" />
      </div>

      <ChartContainer title="กราฟหลัก" subtitle="สี chart-1..6, grid บาง, tooltip ผ่าน helper" height={260}>
        <AreaChart data={SERIES}>
          <CartesianGrid {...CHART.grid} />
          <XAxis dataKey="m" {...CHART.axis} />
          <YAxis {...CHART.axis} width={40} tickFormatter={(v) => formatNumber(Number(v), 0)} />
          <Tooltip {...CHART.tooltip} formatter={(v) => formatNumber(Number(v), 1)} />
          <Area dataKey="a" stroke={CHART.colors[0]} fill={CHART.colors[0]} fillOpacity={0.12} isAnimationActive={false} />
          <Area dataKey="b" stroke={CHART.colors[1]} fill="none" isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>

      <Section title="DataTable" subtitle="header sticky · คลิกหัวคอลัมน์เพื่อเรียง · ค่าว่างเรียงท้ายสุด">
        <DataTable columns={COLS} rows={ROWS} rowKey={(r) => r.symbol} defaultSort={{ key: "upside", dir: "desc" }} caption="ตัวอย่างตาราง" />
      </Section>

      <Section title="Tabs / Collapsible">
        <Tabs
          ariaLabel="ตัวอย่างแท็บ"
          tabs={[
            { id: "a", label: "ภาพรวม", content: <p className="text-sm text-text-muted">เนื้อหาแท็บแรก</p> },
            { id: "b", label: "สมมติฐาน", badge: 3, content: <p className="text-sm text-text-muted">รายละเอียดเชิงลึกซ่อนไว้ในแท็บ</p> },
            { id: "c", label: "Sensitivity", content: <p className="text-sm text-text-muted">ตาราง sensitivity</p> },
          ]}
        />
        <Collapsible className="mt-4" title="สมมติฐาน DCF" meta="5 ข้อ">
          <p className="text-sm text-text-muted">รายละเอียดที่พับเก็บได้</p>
        </Collapsible>
      </Section>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="space-y-2">
          <div className="text-sm font-medium">Badge</div>
          <div className="flex flex-wrap gap-2">
            <Badge status="green">Green</Badge>
            <Badge status="yellow">Yellow</Badge>
            <Badge status="red">Red</Badge>
            <Badge status="info">Base</Badge>
            <Badge>Conviction สูง</Badge>
          </div>
        </Card>
        <Card className="space-y-2">
          <div className="text-sm font-medium">Skeleton</div>
          <Skeleton lines={4} />
        </Card>
        <Card className="space-y-2">
          <div className="text-sm font-medium">ErrorState</div>
          <ErrorState message="โหลดข้อมูลไม่สำเร็จ ลองรีเฟรชหน้านี้อีกครั้ง" />
        </Card>
      </div>
      <EmptyState title="ยังไม่มี Valuation" description="เพิ่ม Valuation แรกเพื่อดูมูลค่ายุติธรรมของสินทรัพย์นี้" action={<button className="btn">เพิ่ม Valuation</button>} />
    </div>
  );
}
