import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import path from "node:path";

const withNextIntl = createNextIntlPlugin({
  experimental: {
    srcPath: "./src",
    extract: true,
    messages: {
      sourceLocale: "en",
      path: "./messages",
      format: "json",
      locales: ["en", "de", "fr", "zh", "es", "pl", "it", "ko", "pt", "ja", "cs", "uk"],
    },
  },
});

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname, ".."),
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
  env: {
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
    NEXT_PUBLIC_DISABLE_SIGNUP: process.env.NEXT_PUBLIC_DISABLE_SIGNUP,
    NEXT_PUBLIC_LITE_DASHBOARD: process.env.NEXT_PUBLIC_LITE_DASHBOARD,
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version,
  },
  async headers() {
    return [
      // Belt and braces with robots.txt. A crawler that honours robots.txt never
      // gets here; one that ignores it still sees this, and a noindex header on
      // a page that is already indexed pulls it back out of the index. Every
      // path here is a dashboard: a site id, a private-link key, or somebody's
      // analytics. None of it should be findable.
      { source: "/", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      {
        // Nothing may frame the app from another origin: a signed-in page in
        // someone else's iframe (OAuth consent above all) is a click away
        // from being used against the person looking at it. The embed widget
        // is left out; its route handler sets its own policy.
        source: "/((?!widget/).*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }],
      },
      {
        // Dashboard embeds are private-link pages (/{siteId}/{privateKey}/...)
        // made to be framed, and read-only for whoever holds the link. Listed
        // last: for the same header, the last matching rule wins.
        source: "/:siteId/:privateKey([a-fA-F0-9]{12})/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
