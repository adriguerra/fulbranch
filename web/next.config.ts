import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    FULBRANCH_API_URL: process.env.FULBRANCH_API_URL ?? "http://localhost:3000",
  },
};

export default nextConfig;
