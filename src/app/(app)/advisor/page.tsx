import { AdvisorChat } from "@/components/AdvisorChat";
import { PageHeader } from "@/components/ui";
import { getThread, listThreads } from "@/server/services/advisor-threads";

export default async function AdvisorPage({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  const sp = await searchParams;
  const [threads, thread] = await Promise.all([listThreads(), sp.thread ? getThread(Number(sp.thread)) : null]);
  const configured = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return (
    <>
      <PageHeader title="AI ที่ปรึกษาการลงทุน" subtitle="ขับเคลื่อนด้วย Claude — วิเคราะห์จากข้อมูลพอร์ตจริงและเครื่องมือคำนวณทางการเงินของแอป" />
      {!configured && (
        <p className="rounded-lg border border-neg/40 p-3 text-sm text-neg">
          ยังไม่ได้ตั้งค่า <code>ANTHROPIC_API_KEY</code> — สร้างคีย์ที่ console.anthropic.com แล้วใส่ใน Vercel → Environment Variables
        </p>
      )}
      <AdvisorChat key={thread?.id ?? "new"} threadId={thread?.id ?? null} initial={thread?.messages ?? []} threads={threads} />
    </>
  );
}
