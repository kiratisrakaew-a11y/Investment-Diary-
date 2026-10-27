import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Investment Diary",
  description: "บันทึกการลงทุน ติดตามพอร์ต และวัดผลตามทฤษฎีการเงิน",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" data-theme="dim" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint (default: dim). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dim")document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
