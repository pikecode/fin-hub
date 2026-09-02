import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  devIndicators: false,
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions ?? {}),
        ignored: [
          "**/node_modules/**",
          "**/.next/**",
          "**/.next.bak-*/**",
          "**/.next-build-backup-*/**",
          "**/dist/**",
          "**/*.tsbuildinfo",
        ],
      };
    }
    return config;
  },
  transpilePackages: [
    "@fin-hub/shared-api-client",
    "@fin-hub/shared-types",
    "@fin-hub/shared-utils",
  ],
};

export default nextConfig;
