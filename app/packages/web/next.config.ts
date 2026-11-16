import type { NextConfig } from "next";

const apiOrigin = process.env.AEION_INTERNAL_API_ORIGIN || "http://127.0.0.1:4171";

const nextConfig: NextConfig = {
  // The repository keeps one AGENTS.md at its root; `next dev` must not write a second one here.
  agentRules: false,
  transpilePackages: ["@aeion-spec/shared"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/api/:path*`,
      },
      {
        source: "/v1/:path*",
        destination: `${apiOrigin}/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
