import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["yahoo-finance2"],
  experimental: { optimizePackageImports: ["@phosphor-icons/react/ssr"] },
};

export default nextConfig;
