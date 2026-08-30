import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  devIndicators: false,
  transpilePackages: [
    "@fin-hub/shared-api-client",
    "@fin-hub/shared-types",
    "@fin-hub/shared-utils",
  ],
};

export default nextConfig;
