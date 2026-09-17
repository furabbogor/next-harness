import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  outputFileTracingExcludes: {
    "/*": ["./deepseek-harness-master/**/*", "./.harness/**/*", "./tests/**/*", "./e2e/**/*"],
  },
  outputFileTracingIncludes: {
    "/api/**/*": ["./runtime/**/*", "./node_modules/quickjs-emscripten/**/*", "./node_modules/quickjs-emscripten-core/**/*", "./node_modules/@jitl/**/*"],
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
    ] }];
  },
};
export default nextConfig;
