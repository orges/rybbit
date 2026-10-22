import type { MetadataRoute } from "next";

/**
 * This app is a dashboard, not a website.
 *
 * Every path here is a site id, a private-link key, or a page of somebody's
 * analytics — none of it is meant to be found, and a crawler that follows a
 * link to a private dashboard can walk it. Disallowing everything is the only
 * rule that covers the paths nobody remembers to protect, including the ones
 * under a private-link key.
 *
 * The docs site is a separate app and stays indexable.
 */
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
