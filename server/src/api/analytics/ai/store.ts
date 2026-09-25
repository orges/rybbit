import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "../../../db/postgres/postgres.js";
import { aiConversations, aiFeedback, aiMemories, aiMessages, aiRuns } from "../../../db/postgres/schema.js";
import type { Artifact } from "./presentation.js";
import type { ToolCallRecord } from "./agent.js";

/**
 * Durable state for the analyst.
 *
 * A conversation is a transcript, not a cache: reopening one replays the same
 * messages, tool cards and artifacts the user saw, with no analytics re-queried.
 * Only what the user saw is stored — the prose, the rendered artifact and a
 * summary of each tool call. Raw ClickHouse rows stay out of Postgres.
 */

export interface AssistantParts {
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  artifacts?: Artifact[];
  model?: string;
  steps?: number;
  stopped?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  unverified?: string[];
}

export interface UserParts {
  context?: {
    startDate?: string;
    endDate?: string;
    rangeLabel?: string;
    timezone?: string;
    filters?: unknown[];
    page?: string;
  };
}

/**
 * The AI tables are `timestamp` columns read back as bare wall-clock strings, so
 * `2026-09-25 19:35:23.832` carries no offset. A client that parses that as
 * local time is off by the viewer's offset — two hours in summer here, which
 * made every thread read "2h ago" the moment it was written. Everything leaving
 * this module is unambiguous UTC.
 */
function asUtcIso(value: string | null | undefined) {
  if (!value) return undefined;
  return /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
}

const owned = (userId: string, organizationId: string, siteId: number, id: string) =>
  and(
    eq(aiConversations.id, id),
    eq(aiConversations.userId, userId),
    eq(aiConversations.organizationId, organizationId),
    eq(aiConversations.siteId, siteId)
  );

export async function findConversation(userId: string, organizationId: string, siteId: number, id: string) {
  const [row] = await db
    .select({ id: aiConversations.id, title: aiConversations.title })
    .from(aiConversations)
    .where(owned(userId, organizationId, siteId, id))
    .limit(1);
  return row;
}

export async function listConversations(
  userId: string,
  organizationId: string,
  siteId: number,
  search?: string
) {
  const owner = and(
    eq(aiConversations.userId, userId),
    eq(aiConversations.organizationId, organizationId),
    eq(aiConversations.siteId, siteId)
  );

  // A search term looks in what was actually said, not just in the title: people
  // remember the question they asked, and the title is only its first words.
  if (search?.trim()) {
    const term = likeTerm(search);
    const hits = await db
      .selectDistinct({ id: aiConversations.id, content: aiMessages.content })
      .from(aiConversations)
      .innerJoin(aiMessages, eq(aiMessages.conversationId, aiConversations.id))
      .where(and(owner, or(ilike(aiMessages.content, term), ilike(aiConversations.title, term))))
      .limit(200);
    if (!hits.length) return [];
    const byId = new Map(hits.map(hit => [hit.id, hit.content]));
    const rows = await db
      .select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt })
      .from(aiConversations)
      .where(and(owner, inArray(aiConversations.id, [...byId.keys()])))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(50);
    return rows.map(row => ({
      ...row,
      updatedAt: asUtcIso(row.updatedAt) ?? row.updatedAt,
      snippet: snippetAround(byId.get(row.id) ?? "", search.trim()),
    }));
  }

  // ponytail: newest 50 threads; add cursor pagination when a Site needs more.
  return db
    .select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt })
    .from(aiConversations)
    .where(owner)
    .orderBy(desc(aiConversations.updatedAt))
    .limit(50)
    .then(rows => rows.map(row => ({ ...row, updatedAt: asUtcIso(row.updatedAt) ?? row.updatedAt })));
}

/** Wraps a search term for ILIKE, escaping the wildcards a user may type. */
export function likeTerm(search: string) {
  return `%${search.trim().replace(/[%_\\]/g, match => `\\${match}`)}%`;
}

/** The run of text around the match, so a search result says why it matched. */
function snippetAround(content: string, term: string) {
  const at = content.toLowerCase().indexOf(term.toLowerCase());
  if (at === -1) return undefined;
  const start = Math.max(0, at - 60);
  const end = Math.min(content.length, at + term.length + 90);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).replace(/\s+/g, " ").trim()}${end < content.length ? "…" : ""}`;
}

export async function createConversation(input: {
  userId: string;
  organizationId: string;
  siteId: number;
  title: string;
}) {
  const [row] = await db
    .insert(aiConversations)
    .values({ ...input, title: input.title.slice(0, 120) })
    .returning({ id: aiConversations.id, title: aiConversations.title });
  return row;
}

export async function touchConversation(id: string) {
  await db.update(aiConversations).set({ updatedAt: new Date().toISOString() }).where(eq(aiConversations.id, id));
}

export async function renameConversation(id: string, title: string) {
  const [row] = await db
    .update(aiConversations)
    .set({ title: title.slice(0, 120), updatedAt: new Date().toISOString() })
    .where(eq(aiConversations.id, id))
    .returning({ id: aiConversations.id, title: aiConversations.title });
  return row;
}

export async function deleteConversation(id: string) {
  await db.delete(aiConversations).where(eq(aiConversations.id, id));
}

export async function appendMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  parts: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(aiMessages)
    .values({ ...input, parts: input.parts as Record<string, unknown> })
    .returning({ id: aiMessages.id, role: aiMessages.role, content: aiMessages.content, parts: aiMessages.parts });
  await touchConversation(input.conversationId);
  return row;
}

/** The last user turn, used to rebuild history for the next model call. */
export async function recentMessages(conversationId: string, limit = 20) {
  // ponytail: the tail is enough for a follow-up; summarize older turns when
  // conversations routinely exceed it.
  return db
    .select({ role: aiMessages.role, content: aiMessages.content, parts: aiMessages.parts })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(limit);
}

export async function allMessages(conversationId: string) {
  return db
    .select({
      id: aiMessages.id,
      role: aiMessages.role,
      content: aiMessages.content,
      parts: aiMessages.parts,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(aiMessages.createdAt);
}

/**
 * Flattens a stored row into the message shape the client renders.
 *
 * `parts` is one JSON column so a turn stays atomic, but the UI reads the tool
 * trail, artifacts and usage as fields of the message. Without this the client
 * would have to know about storage.
 */
export function toClientMessage(row: {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Record<string, unknown> | null;
  createdAt?: string;
}) {
  const parts = (row.parts ?? {}) as AssistantParts & { context?: unknown };
  const createdAt = asUtcIso(row.createdAt);
  if (row.role === "user") {
    return { id: row.id, role: row.role, content: row.content, ...(createdAt ? { createdAt } : {}), context: parts.context };
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    ...(createdAt ? { createdAt } : {}),
    ...(parts.reasoning ? { reasoning: parts.reasoning } : {}),
    ...(parts.toolCalls?.length ? { toolCalls: parts.toolCalls } : {}),
    ...(parts.artifacts?.length ? { artifacts: parts.artifacts } : {}),
    ...(parts.usage ? { usage: parts.usage } : {}),
    ...(parts.model ? { model: parts.model } : {}),
    ...(parts.stopped ? { stopped: parts.stopped } : {}),
    ...(parts.unverified?.length ? { unverified: parts.unverified } : {}),
  };
}
/** Removes the trailing assistant turn so a retry can replace it. */
export async function dropLastAssistantMessage(conversationId: string) {
  const rows = await db
    .select({ id: aiMessages.id, role: aiMessages.role })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(2);
  const assistant = rows.find(row => row.role === "assistant");
  if (assistant) await db.delete(aiMessages).where(eq(aiMessages.id, assistant.id));
}

export async function recordRun(input: {
  conversationId: string;
  messageId?: string;
  model: string;
  status: "completed" | "stopped" | "error";
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  steps: number;
  error?: string;
}) {
  await db.insert(aiRuns).values({ ...input, error: input.error?.slice(0, 500) });
}

export async function listMemories(organizationId: string, siteId: number) {
  return db
    .select({ id: aiMemories.id, content: aiMemories.content, createdAt: aiMemories.createdAt })
    .from(aiMemories)
    .where(and(eq(aiMemories.organizationId, organizationId), eq(aiMemories.siteId, siteId)))
    .orderBy(desc(aiMemories.createdAt))
    .limit(50)
    .then(rows => rows.map(row => ({ ...row, createdAt: asUtcIso(row.createdAt) ?? row.createdAt })));
}

export const __testing = { snippetAround };
export { asUtcIso };

export async function addMemory(input: {
  organizationId: string;
  siteId: number;
  content: string;
  createdBy?: string;
}) {
  const [row] = await db.insert(aiMemories).values(input).returning({ id: aiMemories.id });
  return row;
}

export async function deleteMemory(id: string) {
  await db.delete(aiMemories).where(eq(aiMemories.id, id));
}

export async function setFeedback(messageId: string, rating: number, comment?: string) {
  await db
    .insert(aiFeedback)
    .values({ messageId, rating, comment: comment?.slice(0, 1000) })
    .onConflictDoUpdate({ target: aiFeedback.messageId, set: { rating, comment: comment?.slice(0, 1000) } });
}
