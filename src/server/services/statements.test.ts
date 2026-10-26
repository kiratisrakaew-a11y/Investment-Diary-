import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { detectKind, xlsxToText } from "./statements";

describe("statement file parsing", () => {
  it("detects supported file kinds", () => {
    expect(detectKind("งบ 2567.PDF", "")).toBe("pdf");
    expect(detectKind("fs.xlsx", "")).toBe("xlsx");
    expect(detectKind("fs.csv", "text/csv")).toBe("csv");
    expect(detectKind("old.xls", "application/vnd.ms-excel")).toBeNull();
  });

  it("converts every sheet of a workbook to CSV text, using formula results", async () => {
    const wb = new ExcelJS.Workbook();
    const is = wb.addWorksheet("งบกำไรขาดทุน");
    is.addRow(["รายการ", 2023, 2024]);
    is.addRow(["รายได้, รวม", 1000, 1100]);
    is.addRow(["กำไร", { formula: "B2*0.1", result: 100 }, { formula: "C2*0.1", result: 110 }]);
    wb.addWorksheet("Balance").addRow(["Cash", 50, 60]);
    const buf = await wb.xlsx.writeBuffer();
    const { text, truncated } = await xlsxToText(buf as ArrayBuffer);
    expect(truncated).toBe(false);
    expect(text).toContain("### Sheet: งบกำไรขาดทุน");
    expect(text).toContain('"รายได้, รวม",1000,1100');
    expect(text).toContain("กำไร,100,110");
    expect(text).toContain("### Sheet: Balance\nCash,50,60");
  });
});
