import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  ["http://10.10.10.218", false, "lax"],
  ["https://rybbit.example", true, "none"],
])(
  "sets production session cookies for %s",
  async (url, secure, sameSite) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BASE_URL", url);
    vi.resetModules();
    const { auth } = await import("./auth.js");
    expect(auth.options.advanced?.useSecureCookies).toBe(secure);
    expect(auth.options.advanced?.defaultCookieAttributes?.sameSite).toBe(sameSite);
  },
  // The first case boots better-auth for the first time, which takes 4-6s
  // depending on machine load. At the 5s default it failed about half the time,
  // which is worse than no test at all.
  30_000
);
