import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  ["http://10.10.10.218", false, "lax"],
  ["https://rybbit.example", true, "none"],
])("sets production session cookies for %s", async (url, secure, sameSite) => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BASE_URL", url);
  vi.resetModules();
  const { auth } = await import("./auth.js");
  expect(auth.options.advanced?.useSecureCookies).toBe(secure);
  expect(auth.options.advanced?.defaultCookieAttributes?.sameSite).toBe(sameSite);
});
