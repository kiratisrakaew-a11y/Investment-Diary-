import { describe, expect, it } from "vitest";
import { parseDate, parsePriceTable } from "./price-import";

describe("parseDate", () => {
  it("accepts ISO, Thai day-first, Buddhist years, Excel serials and month names", () => {
    expect(parseDate("2026-01-05")).toBe("2026-01-05");
    expect(parseDate("05/01/2026")).toBe("2026-01-05");
    expect(parseDate("5/1/2569")).toBe("2026-01-05");
    expect(parseDate("2569-01-05")).toBe("2026-01-05");
    expect(parseDate("46027")).toBe("2026-01-05"); // Excel serial
    expect(parseDate("Jan 05, 2026")).toBe("2026-01-05");
    expect(parseDate("05-Jan-2026")).toBe("2026-01-05");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("hello")).toBeNull();
  });
});

describe("parsePriceTable", () => {
  it("long format with Thai headers and thousands separators", () => {
    const r = parsePriceTable(`สัญลักษณ์,วันที่,ราคาปิด\nPTT,02/01/2026,"1,034.50"\nptt,05/01/2026,35.25\nBBL,05/01/2026,150`);
    expect(r.format).toBe("long");
    expect(r.rows).toEqual([
      { symbol: "PTT", date: "2026-01-02", close: 1034.5, adjClose: null },
      { symbol: "PTT", date: "2026-01-05", close: 35.25, adjClose: null },
      { symbol: "BBL", date: "2026-01-05", close: 150, adjClose: null },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("wide format: one column per symbol, blanks skipped", () => {
    const r = parsePriceTable(`Date,PTT,BBL\n2026-01-02,34.5,148\n2026-01-05,,150.5`);
    expect(r.format).toBe("wide");
    expect(r.rows).toHaveLength(3);
    expect(r.rows).toContainEqual({ symbol: "BBL", date: "2026-01-05", close: 150.5, adjClose: null });
  });

  it("single-symbol export (Yahoo style) needs the symbol and keeps Adj Close", () => {
    const csv = `Date,Open,High,Low,Close,Adj Close,Volume\n2026-01-02,34,35,33.5,34.5,33.9,1000\n2026-01-05,34.5,35.5,34,35,34.4,900`;
    const r = parsePriceTable(csv, { symbol: "ptt" });
    expect(r.format).toBe("single");
    expect(r.rows[0]).toEqual({ symbol: "PTT", date: "2026-01-02", close: 34.5, adjClose: 33.9 });
    const missing = parsePriceTable(csv);
    expect(missing.rows).toEqual([]);
    expect(missing.errors[0].reason).toContain("symbol");
  });

  it("reports bad lines with their line numbers and keeps the good ones", () => {
    const r = parsePriceTable(`symbol,date,close\nPTT,2026-01-02,34.5\nPTT,not-a-date,35\nPTT,2026-01-06,-1\nPTT,2026-01-07,abc`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5]);
  });

  it("skips '### Sheet' markers and leading notes before the header", () => {
    const r = parsePriceTable(`### Sheet: Prices\nราคาย้อนหลัง\nsymbol,date,close\nPTT,2026-01-02,34.5`);
    expect(r.rows).toHaveLength(1);
  });

  it("no recognizable header → a clear error", () => {
    const r = parsePriceTable(`a,b,c\n1,2,3`);
    expect(r.rows).toEqual([]);
    expect(r.errors[0].reason).toContain("หัวตาราง");
  });
});
