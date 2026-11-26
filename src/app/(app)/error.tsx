"use client";

import { ErrorState } from "@/components/ui";

/** Route-level error state: a readable sentence and a way to retry (no stack traces). */
export default function RouteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="โหลดหน้านี้ไม่สำเร็จ"
      message="เกิดข้อผิดพลาดชั่วคราวระหว่างดึงข้อมูล ลองโหลดใหม่อีกครั้ง หากยังเป็นอยู่ให้ตรวจสอบหน้า “คุณภาพข้อมูล”"
      action={
        <button type="button" className="btn" onClick={reset}>
          ลองอีกครั้ง
        </button>
      }
    />
  );
}
