import { and, desc, eq } from "drizzle-orm";
import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db/postgres/postgres.js";
import { aiConversations, aiMessages } from "../../db/postgres/schema.js";
import { getSitesUserHasAccessTo } from "../../lib/auth-utils.js";

const paramsSchema = z.object({ organizationId: z.string(), conversationId: z.string().uuid().optional() });
const querySchema = z.object({ siteId: z.coerce.number().int().positive() });

function ownedConversation(userId: string, organizationId: string, siteId: number, id: string) {
  return and(
    eq(aiConversations.id, id),
    eq(aiConversations.userId, userId),
    eq(aiConversations.organizationId, organizationId),
    eq(aiConversations.siteId, siteId)
  );
}

export async function canReadConversation(userId: string, organizationId: string, siteId: number, id: string) {
  const [row] = await db
    .select({ id: aiConversations.id })
    .from(aiConversations)
    .where(ownedConversation(userId, organizationId, siteId, id))
    .limit(1);
  return !!row;
}

export async function saveAiExchange(input: {
  userId: string;
  organizationId: string;
  siteId: number;
  conversationId?: string;
  question: string;
  query: string;
  summary: string;
  rows: Record<string, unknown>[];
  rowCount: number;
}) {
  return db.transaction(async tx => {
    let id = input.conversationId;
    if (id) {
      const [owner] = await tx
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(ownedConversation(input.userId, input.organizationId, input.siteId, id))
        .limit(1);
      if (!owner) throw new Error("Conversation not found");
    } else {
      const [row] = await tx
        .insert(aiConversations)
        .values({
          userId: input.userId,
          organizationId: input.organizationId,
          siteId: input.siteId,
          title: input.question.slice(0, 100),
        })
        .returning({ id: aiConversations.id });
      id = row.id;
    }
    // Keep chart-ready aggregates, not full event or replay payloads.
    const rows = input.rows.slice(0, 50).map(row =>
      Object.fromEntries(
        Object.entries(row)
          .slice(0, 20)
          .map(([key, value]) => [
            key,
            typeof value === "number" || typeof value === "boolean" || value == null
              ? value
              : String(value).slice(0, 200),
          ])
      )
    );
    await tx.insert(aiMessages).values({
      conversationId: id,
      question: input.question,
      query: input.query,
      summary: input.summary,
      rows,
      rowCount: input.rowCount,
    });
    await tx
      .update(aiConversations)
      .set({ updatedAt: new Date().toISOString() })
      .where(ownedConversation(input.userId, input.organizationId, input.siteId, id));
    return id;
  });
}

export async function handleAiConversations(
  request: FastifyRequest<{ Params: { organizationId: string; conversationId?: string }; Querystring: unknown }>,
  reply: FastifyReply
) {
  const params = paramsSchema.safeParse(request.params);
  const query = querySchema.safeParse(request.query);
  if (!params.success || !query.success) return reply.status(400).send({ error: "Invalid conversation request" });
  const userId = request.user?.id;
  if (!userId) return reply.status(403).send({ error: "A user session is required" });
  const { organizationId, conversationId } = params.data;
  const { siteId } = query.data;
  const accessible = (await getSitesUserHasAccessTo(request)).some(
    site => site.organizationId === organizationId && site.siteId === siteId
  );
  if (!accessible) return reply.status(403).send({ error: "No access to the requested site" });

  try {
    if (!conversationId) {
      // ponytail: show the latest 30 threads; add cursor pagination when users need older ones.
      const conversations = await db
        .select({
          id: aiConversations.id,
          title: aiConversations.title,
          updatedAt: aiConversations.updatedAt,
        })
        .from(aiConversations)
        .where(
          and(
            eq(aiConversations.userId, userId),
            eq(aiConversations.organizationId, organizationId),
            eq(aiConversations.siteId, siteId)
          )
        )
        .orderBy(desc(aiConversations.updatedAt))
        .limit(30);
      return reply.send(conversations);
    }

    if (!(await canReadConversation(userId, organizationId, siteId, conversationId))) {
      return reply.status(404).send({ error: "Conversation not found" });
    }
    if (request.method === "DELETE") {
      await db.delete(aiConversations).where(ownedConversation(userId, organizationId, siteId, conversationId));
      return reply.send({ success: true });
    }
    // ponytail: show the latest 50 exchanges; add cursor pagination for longer investigations.
    const messages = await db
      .select({
        question: aiMessages.question,
        query: aiMessages.query,
        summary: aiMessages.summary,
        rows: aiMessages.rows,
        rowCount: aiMessages.rowCount,
      })
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conversationId))
      .orderBy(desc(aiMessages.id))
      .limit(50);
    return reply.send(messages.reverse());
  } catch (error) {
    request.log.error(error, "Failed to access AI conversations");
    return reply.status(500).send({ error: "Could not load conversation history" });
  }
}
