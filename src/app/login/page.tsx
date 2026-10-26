import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form action={login} className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Investment Diary</h1>
          <p className="text-sm text-muted">เข้าสู่ระบบด้วยรหัสผ่านของคุณ</p>
        </div>
        <input type="hidden" name="next" value={next ?? "/"} />
        <div>
          <label className="label" htmlFor="password">รหัสผ่าน</label>
          <input id="password" name="password" type="password" className="input" autoFocus required />
        </div>
        {error && <p className="text-sm text-neg">รหัสผ่านไม่ถูกต้อง</p>}
        <button className="btn w-full">เข้าสู่ระบบ</button>
      </form>
    </main>
  );
}
