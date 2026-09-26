import Fastify, { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, expect, it } from "vitest";
import { withRateLimit } from "./withRateLimit.js";

/**
 * The per-route caps in `src/index.ts` are declared as route `config.rateLimit`
 * against a `global: false` registration. That wiring is easy to write and easy
 * to silently lose: a limiter that never engages still lets every request
 * through, so nothing fails loudly. These tests assert the wiring actually caps.
 */

const register = async (limit: { max: number; timeWindow: string }, nested = false) => {
  const app = Fastify();
  // Stands in for the auth pre-handler, which is what puts a user id on the
  // request in production and therefore what the key generator reads.
  app.decorateRequest("userId", null);
  app.addHook("onRequest", async request => {
    (request as unknown as { userId: string | null }).userId = (request.headers["x-user"] as string) ?? null;
  });
  await app.register(rateLimit, {
    global: false,
    hook: "preHandler",
    keyGenerator: request => (request as unknown as { userId?: string | null }).userId ?? request.ip,
  });
  // Production registers its routes inside a nested `server.register(...)` block
  // opened after the limiter, so `nested` reproduces that encapsulation exactly.
  const declare = (scope: FastifyInstance) => {
    scope.post("/capped", { config: { rateLimit: limit } }, async () => ({ ok: true }));
    scope.post("/uncapped", async () => ({ ok: true }));
  };
  if (nested) {
    await app.register(async scope => {
      declare(scope);
    });
  } else {
    declare(app);
  }
  await app.ready();
  return app;
};

const statuses = async (app: Awaited<ReturnType<typeof register>>, path: string, times: number) => {
  const codes: number[] = [];
  for (let i = 0; i < times; i++) {
    codes.push((await app.inject({ method: "POST", url: path })).statusCode);
  }
  return codes;
};

describe("per-route rate limit wiring", () => {
  it("caps a route that declares config.rateLimit", async () => {
    const app = await register({ max: 2, timeWindow: "1 minute" });
    expect(await statuses(app, "/capped", 4)).toEqual([200, 200, 429, 429]);
    await app.close();
  });

  it("leaves a route without config.rateLimit alone", async () => {
    const app = await register({ max: 1, timeWindow: "1 minute" });
    expect(await statuses(app, "/uncapped", 3)).toEqual([200, 200, 200]);
    await app.close();
  });

  it("reports the route's own limit, not the global default", async () => {
    const app = await register({ max: 3, timeWindow: "1 minute" });
    const res = await app.inject({ method: "POST", url: "/capped" });
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
    await app.close();
  });

  it("keys on the user rather than the shared IP", async () => {
    const app = await register({ max: 1, timeWindow: "1 minute" });
    const call = (userId: string) => app.inject({ method: "POST", url: "/capped", headers: { "x-user": userId } });
    // Same IP throughout; a per-user key means one user cannot exhaust another's.
    expect((await call("a")).statusCode).toBe(200);
    expect((await call("a")).statusCode).toBe(429);
    expect((await call("b")).statusCode).toBe(200);
    await app.close();
  });

  it("still caps a route declared inside a nested register block", async () => {
    const app = await register({ max: 2, timeWindow: "1 minute" }, true);
    expect(await statuses(app, "/capped", 3)).toEqual([200, 200, 429]);
    await app.close();
  });

  it("still caps a route two registers deep, as inside the auth plugin", async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: false, hook: "preHandler", keyGenerator: r => r.ip });
    await app.register(async outer => {
      await outer.register(async inner => {
        inner.post("/capped", { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
      });
    });
    await app.ready();
    expect(await statuses(app, "/capped", 3)).toEqual([200, 200, 429]);
    await app.close();
  });

  it("caps a route that also carries its own preHandler chain", async () => {
    // Production routes are `{ preHandler: [...], config: { rateLimit } }`; the
    // limiter's hook has to compose with the auth chain rather than replace it.
    const app = Fastify();
    let preHandlerRuns = 0;
    await app.register(rateLimit, { global: false, hook: "preHandler", keyGenerator: r => r.ip });
    app.post(
      "/capped",
      {
        preHandler: [
          async () => {
            preHandlerRuns++;
          },
        ],
        config: { rateLimit: { max: 2, timeWindow: "1 minute" } },
      },
      async () => ({ ok: true })
    );
    await app.ready();
    expect(await statuses(app, "/capped", 3)).toEqual([200, 200, 429]);
    // The auth chain still runs, including on the request the limiter rejects.
    expect(preHandlerRuns).toBe(3);
    await app.close();
  });

  it("gives each route sharing a base chain its own cap", async () => {
    // Regression: the limiter pushes its hook onto the route's preHandler array,
    // so a shared base chain used to make every route run every cap, and the
    // first one registered set the limit for all of them. The analyst's 10/min
    // was silently running at 60/min because a 60/min route was declared first.
    const app = Fastify();
    await app.register(rateLimit, { global: false, hook: "preHandler", keyGenerator: r => r.ip });
    // One shared base chain, the way `orgSqlRead` is shared across routes.
    const shared = { preHandler: [async () => {}] };
    const cap = (max: number) => withRateLimit(shared, { max, timeWindow: "1 minute" });
    await app.register(async outer => {
      await outer.register(async inner => {
        inner.post("/sixty", cap(60), async () => ({ ok: true }));
        inner.post("/ten", cap(10), async () => ({ ok: true }));
      });
    });
    await app.ready();

    const limitOf = async (path: string) => (await app.inject({ method: "POST", url: path })).headers["x-ratelimit-limit"];
    expect(await limitOf("/sixty")).toBe("60");
    expect(await limitOf("/ten")).toBe("10");
    // And the stricter cap is enforced on its own route: /ten has now taken one
    // request, nine more fit under its cap of ten, and the tenth is over.
    const burst = await statuses(app, "/ten", 10);
    expect(burst.slice(0, 9)).toEqual(Array(9).fill(200));
    expect(burst[9]).toBe(429);
    await app.close();
  });
});
