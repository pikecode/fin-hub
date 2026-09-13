import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  devIndicators: false,
  async rewrites() {
    const apiProxyTarget =
      process.env.ADMIN_WEB_API_PROXY_TARGET ||
      (process.env.NODE_ENV !== "production" ? "http://localhost:8057" : "");
    if (!apiProxyTarget) {
      return [];
    }
    return [
      {
        source: "/api/:path*",
        destination: `${apiProxyTarget.replace(/\/$/, "")}/api/:path*`,
      },
    ];
  },
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
