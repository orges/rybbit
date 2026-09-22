import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, expect, it, vi } from "vitest";

const { db, getSitesUserHasAccessTo } = vi.hoisted(() => ({
  db: { select: vi.fn(), transaction: vi.fn() },
  getSitesUserHasAccessTo: vi.fn(),
}));
vi.mock("../../db/postgres/postgres.js", () => ({ db }));
vi.mock("../../lib/auth-utils.js", () => ({ getSitesUserHasAccessTo }));

import { canReadConversation, handleAiConversations, saveAiExchange } from "./aiConversations.js";
import { aiConversations } from "../../db/postgres/schema.js";

beforeEach(() => {
  vi.clearAllMocks();
});

it("checks conversation ID, user, organization, and Site together", async () => {
  let condition: Parameters<PgDialect["sqlToQuery"]>[0];
  db.select.mockReturnValue({
    from: () => ({
      where: (where: typeof condition) => {
        condition = where;
        return { limit: async () => [] };
      },
    }),
  });
  await expect(canReadConversation("user-1", "org-1", 42, "e8dfdb2e-8159-4d51-a56d-22404613da4e")).resolves.toBe(false);
  expect(new PgDialect().sqlToQuery(condition!).params).toEqual([
    "e8dfdb2e-8159-4d51-a56d-22404613da4e",
    "user-1",
    "org-1",
    42,
  ]);
});

it("does not expose conversations on a Site the user cannot access", async () => {
  getSitesUserHasAccessTo.mockResolvedValue([{ organizationId: "org-1", siteId: 42 }]);
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  await handleAiConversations(
    { params: { organizationId: "org-1" }, query: { siteId: "43" }, user: { id: "user-1" } } as Parameters<
      typeof handleAiConversations
    >[0],
    { status } as unknown as Parameters<typeof handleAiConversations>[1]
  );
  expect(status).toHaveBeenCalledWith(403);
  expect(db.select).not.toHaveBeenCalled();
});

it("saves a completed exchange atomically with compact result rows", async () => {
  const conversationId = "e8dfdb2e-8159-4d51-a56d-22404613da4e";
  let saved: { rows: Record<string, unknown>[] } | undefined;
  const tx = {
    insert: vi.fn(table => ({
      values: vi.fn(values => {
        if (table === aiConversations) return { returning: async () => [{ id: conversationId }] };
        saved = values;
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({ set: () => ({ where: async () => {} }) })),
  };
  db.transaction.mockImplementation(callback => callback(tx));
  const id = await saveAiExchange({
    userId: "user-1",
    organizationId: "org-1",
    siteId: 42,
    question: "What happened?",
    query: "SELECT count() FROM scoped_events",
    summary: "Four visits",
    rows: [{ visits: 4, detail: "x".repeat(1000) }],
    rowCount: 1,
  });
  expect(id).toBe(conversationId);
  expect(saved?.rows).toEqual([{ visits: 4, detail: "x".repeat(200) }]);
  expect(tx.insert).toHaveBeenCalledTimes(2);
});
