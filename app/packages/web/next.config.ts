import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repository keeps one AGENTS.md at its root; `next dev` must not write a second one here.
  agentRules: false,
  transpilePackages: ["@aeion-spec/shared"],
};

export default nextConfig;
