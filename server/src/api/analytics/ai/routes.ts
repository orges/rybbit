import type { OutgoingHttpHeaders } from "node:http";
import { DateTime } from "luxon";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../../db/postgres/postgres.js";
import { sites } from "../../../db/postgres/schema.js";
import { eq } from "drizzle-orm";
import { getSitesUserHasAccessTo } from "../../../lib/auth-utils.js";
import { filterSchema } from "../utils/query-validation.js";
import { OpenRouterError, type OpenRouterMessage } from "../../../lib/openrouter.js";
import { isRetryableAgentError, runAgent, type AgentEvent } from "./agent.js";
import { ANALYST_EXAMPLE_PROMPTS } from "./prompt.js";
import { buildProposalPrompt, PROPOSAL_TOOLS } from "./proposal.js";
import { resolveToolRange, type ResolvedRange } from "./time.js";
import * as store from "./store.js";
import { deriveTitle } from "./title.js";

/**
 * HTTP surface of the analyst.
 *
 * One streaming endpoint does the work, everything else is bookkeeping:
 * conversations, renames, feedback, and the project memory that is injected
 * into the next prompt.
 */

// The dashboard's own filter validator, reused so the chat can never introduce
// a filter shape the analytics endpoints would reject later.
const chatBodySchema = z.object({
  siteId: z.number().int().positive(),
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  regenerate: z.boolean().optional(),
  /** Re-ask from this question: it and everything after it is replaced. */
  editOfMessageId: z.string().uuid().optional(),
  context: z
    .object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      rangeLabel: z.string().max(80).optional(),
      timeZone: z.string().max(80).default("UTC"),
      filters: z.array(filterSchema).max(20).default([]),
      page: z.string().max(60).optional(),
      stat: z.string().max(40).optional(),
    })
    .default({ timeZone: "UTC", filters: [] }),
});

/**
 * A copilot for a page: propose something, hand it back, save nothing.
 *
 * The reply is a value the page's own form can be filled with. There is no
 * conversation, no transcript and no write — the person reviews it and presses
 * save, which is the same button and the same validation they would have used.
 */
const suggestBody = z.object({
  siteId: z.number().int().positive(),
  kind: z.enum(["goal"]),
  ask: z.string().trim().max(300).optional(),
  context: z
    .object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      rangeLabel: z.string().max(80).optional(),
      timeZone: z.string().max(80).default("UTC"),
      filters: z.array(filterSchema).max(20).default([]),
    })
    .default({ timeZone: "UTC", filters: [] }),
});

const conversationParams = z.object({
  organizationId: z.string().min(1),
  conversationId: z.string().uuid().optional(),
});

export async function analystSuggest(
  request: FastifyRequest<{ Params: { organizationId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  const params = conversationParams.safeParse(request.params);
  const body = suggestBody.safeParse(request.body);
  if (!params.success || !body.success) {
    return reply.status(400).send({ error: body.success ? "Invalid request" : body.error.errors[0]?.message });
  }
  const userId = request.user?.id;
  if (!userId) return reply.status(403).send({ error: "A user session is required" });
  const { organizationId } = params.data;
  const { siteId, kind, ask, context } = body.data;
  if (!(await authorize(request, organizationId, siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }

  const abort = new AbortController();
  request.raw.on("aborted", () => abort.abort());

  try {
    const timezone = context.timeZone || "UTC";
    const range: ResolvedRange = {
      startDate: context.startDate,
      endDate: context.endDate,
      label: context.rangeLabel || (context.startDate ? `${context.startDate} to ${context.endDate}` : "the current range"),
    };
    const [site] = await db.select({ name: sites.name }).from(sites).where(eq(sites.siteId, siteId)).limit(1);
    const memories = (await store.listMemories(organizationId, siteId)).map(memory => memory.content);

    const result = await runAgent({
      history: [],
      question: ask?.trim() || `Suggest a goal for ${site?.name ?? "this Site"}.`,
      context: {
        siteId,
        siteName: site?.name,
        timezone,
        rangeLabel: range.label,
        startDate: range.startDate,
        endDate: range.endDate,
        filters: context.filters,
        memories,
        today: DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd"),
        systemPrompt: buildProposalPrompt(kind, ask, {
          siteName: site?.name,
          rangeLabel: range.label,
          today: DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd"),
        }),
      },
      toolContext: {
        siteId,
        siteIds: [siteId],
        timezone,
        defaultRange: resolveToolRange(undefined, range, timezone),
        filters: context.filters,
        signal: abort.signal,
      },
      tools: PROPOSAL_TOOLS,
      emit: () => {},
      signal: abort.signal,
    });

    if (result.error) return reply.status(502).send({ error: "The suggestion could not be made" });
    if (!result.proposal) {
      // The model answered without proposing. Its own words are the honest
      // thing to show, rather than an empty form.
      return reply.send({ reason: result.text.slice(0, 600), proposal: null });
    }
    return reply.send({
      proposal: result.proposal,
      reason: result.proposal.reason,
      // What it looked at, so the person can judge the proposal rather than
      // trusting it.
      looked: result.toolCalls
        .filter(call => call.name !== "propose_goal" && call.ok)
        .map(call => ({ name: call.name, input: call.input })),
    });
  } catch (error) {
    request.log.error({ err: error }, "Analyst suggestion failed");
    if (abort.signal.aborted) return reply;
    return reply
      .status(error instanceof OpenRouterError && error.code === "missing_api_key" ? 503 : 502)
      .send({ error: "The suggestion could not be made" });
  } finally {
    request.raw.off("aborted", () => abort.abort());
  }
}

const siteQuery = z.object({ siteId: z.coerce.number().int().positive(), search: z.string().max(200).optional() });

/**
 * Resolves the caller's access to the Site the question is about. Every route
 * starts here: a conversation id is only ever acted on after this succeeds, so
 * there is no path that reaches another user's threads.
 */
async function authorize(request: FastifyRequest, organizationId: string, siteId: number): Promise<boolean> {
  if (!request.user?.id) return false;
  const accessible = await getSitesUserHasAccessTo(request);
  return accessible.some(site => site.organizationId === organizationId && site.siteId === siteId);
}

function startSse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    ...reply.getHeaders(),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  } as OutgoingHttpHeaders);
  return (event: AgentEvent | { type: "conversation"; conversationId: string }) => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

export async function analystChat(
  request: FastifyRequest<{ Params: { organizationId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  const params = conversationParams.safeParse(request.params);
  const body = chatBodySchema.safeParse(request.body);
  if (!params.success || !body.success) {
    return reply.status(400).send({ error: body.success ? "Invalid request" : body.error.errors[0]?.message });
  }
  const userId = request.user?.id;
  if (!userId) return reply.status(403).send({ error: "A user session is required" });
  const { organizationId } = params.data;
  const { siteId, message, conversationId, regenerate, editOfMessageId, context } = body.data;
  if (!(await authorize(request, organizationId, siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }

  const abort = new AbortController();
  const onClose = () => abort.abort();
  request.raw.on("aborted", onClose);
  reply.raw.on("close", onClose);

  try {
    let conversation = conversationId ? await store.findConversation(userId, organizationId, siteId, conversationId) : undefined;
    if (conversationId && !conversation) return reply.status(404).send({ error: "Conversation not found" });
    const isNew = !conversation;
    conversation ??= await store.createConversation({
      userId,
      organizationId,
      siteId,
      title: deriveTitle(message),
    });

    // A retry replaces the previous answer rather than stacking a second one on
    // the same question.
    if (regenerate) await store.dropLastAssistantMessage(conversation.id);
    // Re-asking a different question from the same point: the old question and
    // the turns that answered it go, and the new one answers off the history
    // that came before.
    let retitled: string | undefined;
    if (editOfMessageId) {
      const edit = await store.truncateAfter(conversation.id, editOfMessageId);
      if (!edit.ok) {
        return reply
          .status(edit.reason === "message_not_found" ? 404 : 400)
          .send({ error: edit.reason === "message_not_found" ? "Question not found" : "Only a question can be edited" });
      }
      if (edit.replacedOpening) retitled = deriveTitle(message);
    }
    const history: OpenRouterMessage[] = (await store.recentMessages(conversation.id, 20))
      .reverse()
      .map(row => ({ role: row.role, content: row.content }) as OpenRouterMessage)
      .filter(row => (row.content ?? "").trim().length > 0);
    // The turn being answered is appended after this, so a retry of the same
    // question must not also arrive as history.
    const last = history[history.length - 1];
    if (last?.role === "user" && last.content === message) history.pop();

    const timezone = context.timeZone || "UTC";
    const range: ResolvedRange = {
      startDate: context.startDate,
      endDate: context.endDate,
      label: context.rangeLabel || (context.startDate ? `${context.startDate} to ${context.endDate}` : "the current range"),
    };
    const [site] = await db.select({ name: sites.name }).from(sites).where(eq(sites.siteId, siteId)).limit(1);
    const memories = (await store.listMemories(organizationId, siteId)).map(memory => memory.content);
    let turn: { id: string } | undefined;

    if (!regenerate) {
      turn = await store.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: message,
        parts: { context: { ...context } },
      });
    }

    const send = startSse(reply);
    send({ type: "conversation", conversationId: conversation.id });
    // The question needs its stored id before the answer does: re-asking it is a
    // request the server resolves by id.
    if (turn) send({ type: "user_message_id", messageId: turn.id });
    if (retitled) {
      await store.renameConversation(conversation.id, retitled);
      send({ type: "title", title: retitled });
    }

    const started = Date.now();
    const result = await runAgent({
      history,
      question: message,
      context: {
        siteId,
        siteName: site?.name,
        timezone,
        rangeLabel: range.label,
        startDate: range.startDate,
        endDate: range.endDate,
        filters: context.filters,
        page: context.page,
        stat: context.stat,
        memories,
        today: DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd"),
      },
      toolContext: {
        siteId,
        siteIds: [siteId],
        timezone,
        defaultRange: resolveToolRange(undefined, range, timezone),
        filters: context.filters,
        signal: abort.signal,
      },
      emit: send,
      signal: abort.signal,
    });

    const assistant = await store.appendMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: result.text,
      parts: {
        reasoning: result.reasoning,
        toolCalls: result.toolCalls,
        artifacts: result.artifacts,
        model: result.model,
        steps: result.steps,
        stopped: result.stopped,
        usage: result.usage,
        unverified: result.unverified,
      },
    });
    await store.recordRun({
      conversationId: conversation.id,
      messageId: assistant.id,
      model: result.model,
      status: result.error ? "error" : result.stopped ? "stopped" : "completed",
      inputTokens: result.usage.prompt_tokens ?? 0,
      outputTokens: result.usage.completion_tokens ?? 0,
      durationMs: Date.now() - started,
      steps: result.steps,
      ...(result.error ? { error: result.error } : {}),
    });

    if (isNew) {
      const title = deriveTitle(message);
      await store.renameConversation(conversation.id, title);
      send({ type: "title", title });
    }
    send({ type: "message_id", messageId: assistant.id });
    send({ type: "done", stopped: result.stopped, steps: result.steps });
    reply.raw.end();
    return reply;
  } catch (error) {
    request.log.error({ err: error }, "Analyst run failed");
    if (abort.signal.aborted) return reply;
    if (reply.raw.headersSent) {
      const retryable = isRetryableAgentError(error);
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "error",
          message:
            error instanceof OpenRouterError && error.code === "missing_api_key"
              ? "The AI analyst is not configured on this instance."
              : "The analyst could not finish this answer.",
          retryable,
        })}\n\n`
      );
      reply.raw.end();
      return reply;
    }
    return reply
      .status(error instanceof OpenRouterError && error.code === "missing_api_key" ? 503 : 502)
      .send({ error: "The analyst could not answer that" });
  } finally {
    request.raw.off("aborted", onClose);
    reply.raw.off("close", onClose);
  }
}

export async function handleConversations(
  request: FastifyRequest<{ Params: { organizationId: string; conversationId?: string }; Querystring: unknown; Body: unknown }>,
  reply: FastifyReply
) {
  const params = conversationParams.safeParse(request.params);
  const query = siteQuery.safeParse(request.query);
  if (!params.success || !query.success) return reply.status(400).send({ error: "Invalid conversation request" });
  const userId = request.user?.id;
  if (!userId) return reply.status(403).send({ error: "A user session is required" });
  const { organizationId, conversationId } = params.data;
  const { siteId } = query.data;
  if (!(await authorize(request, organizationId, siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }

  try {
    if (!conversationId) {
      return reply.send(await store.listConversations(userId, organizationId, siteId, query.data.search));
    }
    const conversation = await store.findConversation(userId, organizationId, siteId, conversationId);
    if (!conversation) return reply.status(404).send({ error: "Conversation not found" });

    if (request.method === "DELETE") {
      await store.deleteConversation(conversationId);
      return reply.send({ success: true });
    }
    if (request.method === "PATCH") {
      const title = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(request.body);
      if (!title.success) return reply.status(400).send({ error: "Invalid title" });
      const updated = await store.renameConversation(conversationId, title.data.title);
      return reply.send(updated);
    }
    const rows = await store.allMessages(conversationId);
    return reply.send({
      id: conversation.id,
      title: conversation.title,
      messages: rows.map(store.toClientMessage),
    });
  } catch (error) {
    request.log.error(error, "Failed to access AI conversations");
    return reply.status(500).send({ error: "Could not load conversation history" });
  }
}

const feedbackBody = z.object({
  siteId: z.number().int().positive(),
  messageId: z.string().uuid(),
  rating: z.number().int().min(-1).max(1),
  comment: z.string().max(1000).optional(),
});

export async function handleFeedback(
  request: FastifyRequest<{ Params: { organizationId: string }; Body: unknown }>,
  reply: FastifyReply
) {
  const params = conversationParams.safeParse(request.params);
  const body = feedbackBody.safeParse(request.body);
  if (!params.success || !body.success) return reply.status(400).send({ error: "Invalid feedback" });
  if (!(await authorize(request, params.data.organizationId, body.data.siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }
  try {
    await store.setFeedback(body.data.messageId, body.data.rating, body.data.comment);
    return reply.send({ success: true });
  } catch (error) {
    request.log.error(error, "Failed to record AI feedback");
    return reply.status(500).send({ error: "Could not record feedback" });
  }
}

const memoryBody = z.object({
  siteId: z.number().int().positive(),
  content: z.string().trim().min(1).max(2000),
});

export async function handleMemories(
  request: FastifyRequest<{ Params: { organizationId: string; memoryId?: string }; Querystring: unknown; Body: unknown }>,
  reply: FastifyReply
) {
  const params = z.object({ organizationId: z.string().min(1), memoryId: z.string().uuid().optional() }).safeParse(request.params);
  const query = siteQuery.safeParse(request.query);
  if (!params.success || !query.success) return reply.status(400).send({ error: "Invalid memory request" });
  const { organizationId } = params.data;
  const siteId = request.method === "GET" || request.method === "DELETE" ? query.data.siteId : undefined;
  if (!siteId) return reply.status(400).send({ error: "siteId is required" });
  if (!(await authorize(request, organizationId, siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }
  try {
    if (request.method === "GET") return reply.send(await store.listMemories(organizationId, siteId));
    if (request.method === "DELETE") {
      if (!params.data.memoryId) return reply.status(400).send({ error: "Invalid memory id" });
      await store.deleteMemory(params.data.memoryId);
      return reply.send({ success: true });
    }
    const body = memoryBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.errors[0]?.message });
    const row = await store.addMemory({
      organizationId,
      siteId: body.data.siteId,
      content: body.data.content,
      createdBy: request.user?.id,
    });
    return reply.send(row);
  } catch (error) {
    request.log.error(error, "Failed to manage AI memory");
    return reply.status(500).send({ error: "Could not update project memory" });
  }
}

export { ANALYST_EXAMPLE_PROMPTS };
