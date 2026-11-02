import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // GPX race courses are uploaded through a server action (files up to 5 MB)
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
