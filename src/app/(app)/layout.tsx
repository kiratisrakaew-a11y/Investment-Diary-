import { Nav } from "@/components/Nav";
import { logout } from "../login/actions";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav logout={logout} />
      <div className="lg:pl-60">
        <main className="mx-auto max-w-[1400px] space-y-5 px-4 py-5 lg:px-6">{children}</main>
      </div>
    </>
  );
}
