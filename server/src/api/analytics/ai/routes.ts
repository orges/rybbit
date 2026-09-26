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
import { resolvePreset, resolveToolRange, type ResolvedRange } from "./time.js";
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
 * The reply is a value the page's own form can be filled with. Nothing is
 * written — the person reviews it and presses save, which is the same button and
 * the same validation they would have used.
 *
 * It is a conversation, not a button: the page sends the proposal being revised
 * along with the instruction for the next one, so "make it three steps" means
 * something. That context rides along with the request rather than being stored —
 * a copilot thread ends with the page, and there is no transcript to keep.
 */
const suggestBody = z.object({
  siteId: z.number().int().positive(),
  kind: z.enum(["goal", "funnel", "dashboard"]),
  ask: z.string().trim().max(300).optional(),
  /** The proposal being revised, so an instruction about it can act on it. */
  previous: z
    .object({
      value: z.record(z.string(), z.unknown()),
      reason: z.string().max(400).default(""),
      /** The instruction that produced it. */
      ask: z.string().max(300).optional(),
    })
    .optional(),
  context: z
    .object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      rangeLabel: z.string().max(80).optional(),
      timeZone: z.string().max(80).default("UTC"),
      filters: z.array(filterSchema).max(20).default([]),
      /**
       * What the page already tracks, as name and condition. A duplicate is the
       * same condition under a different name, so the condition is what gets
       * checked; the name is for the prompt.
       */
      existing: z
        .array(z.object({ name: z.string().max(120).optional(), condition: z.string().max(200) }))
        .max(50)
        .default([]),
    })
    .default({ timeZone: "UTC", filters: [], existing: [] }),
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
  const { siteId, kind, ask, previous, context } = body.data;
  if (!(await authorize(request, organizationId, siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }

  const abort = new AbortController();
  // Kept as a value so the listener can actually be removed: an inline closure in
  // `off` is a different function, which left the `finally` doing nothing.
  const onAborted = () => abort.abort();
  request.raw.on("aborted", onAborted);

  try {
    const timezone = context.timeZone || "UTC";
    const [site] = await db.select({ name: sites.name }).from(sites).where(eq(sites.siteId, siteId)).limit(1);
    const memories = (await store.listMemories(organizationId, siteId)).map(memory => memory.content);

    const today = DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");
    // A proposal asks what exists on a Site, which the dashboard's current window
    // cannot answer: on a quiet site "today" is empty, and the copilot then has
    // nothing to propose from. A month is long enough for any real page or event
    // to have shown up. Filters still apply — a proposal about a filtered view is
    // still a valid one.
    const window = resolvePreset("last_30_days", timezone);
    // The proposal being revised, as the model's own prior turn, so an
    // instruction like "make it three steps" has something to act on.
    const history = previous
      ? ([
          { role: "user" as const, content: previous.ask?.trim() || `Suggest a ${kind}.` },
          { role: "assistant" as const, content: JSON.stringify({ proposal: previous.value, reason: previous.reason }) },
        ] satisfies OpenRouterMessage[])
      : [];
    const result = await runAgent({
      history,
      question:
        ask?.trim() ||
        (previous ? `Revise the ${kind} you just proposed.` : `Suggest a ${kind} for ${site?.name ?? "this Site"}.`),
      context: {
        siteId,
        siteName: site?.name,
        timezone,
        rangeLabel: window.label,
        startDate: window.startDate,
        endDate: window.endDate,
        filters: context.filters,
        memories,
        today,
        systemPrompt: buildProposalPrompt(kind, ask, {
          siteName: site?.name,
          rangeLabel: window.label,
          today,
          revising: Boolean(previous),
          existing: context.existing,
        }),
      },
      toolContext: {
        siteId,
        siteIds: [siteId],
        timezone,
        defaultRange: window,
        filters: context.filters,
        existingConditions: context.existing.map(entry => entry.condition),
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
    request.raw.off("aborted", onAborted);
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
  const userId = request.user?.id;
  if (!userId) return reply.status(403).send({ error: "A user session is required" });
  const { organizationId } = params.data;
  const { siteId, messageId, rating, comment } = body.data;
  if (!(await authorize(request, organizationId, siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }
  try {
    // 404 rather than 403: a message in another organization is not this caller's
    // to know about, and a 403 would confirm the id exists.
    if (!(await store.setFeedback(messageId, rating, comment, { userId, organizationId, siteId }))) {
      return reply.status(404).send({ error: "Message not found" });
    }
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
  if (!params.success) return reply.status(400).send({ error: "Invalid memory request" });
  const { organizationId } = params.data;
  // Reading and deleting name the Site in the query; writing carries it in the
  // body, which is the body being validated anyway. The old ternary read only the
  // query, so POST could never name a Site and every write was a 400 — a feature
  // that looked like it worked and stored nothing.
  const query = request.method === "POST" ? undefined : siteQuery.safeParse(request.query);
  if (query && !query.success) return reply.status(400).send({ error: "Invalid memory request" });
  const body = request.method === "POST" ? memoryBody.safeParse(request.body) : undefined;
  if (body && !body.success) return reply.status(400).send({ error: body.error.errors[0]?.message });
  const siteId = body?.data.siteId ?? query?.data.siteId;
  if (!siteId) return reply.status(400).send({ error: "siteId is required" });
  if (!(await authorize(request, organizationId, siteId))) {
    return reply.status(403).send({ error: "No access to the requested site" });
  }
  try {
    if (request.method === "GET") return reply.send(await store.listMemories(organizationId, siteId));
    if (request.method === "DELETE") {
      if (!params.data.memoryId) return reply.status(400).send({ error: "Invalid memory id" });
      // Scoped in the store rather than here: authorizing `siteId` and then
      // deleting by bare id is how one tenant deletes another tenant's memory.
      if (!(await store.deleteMemory(params.data.memoryId, organizationId, siteId))) {
        return reply.status(404).send({ error: "Memory not found" });
      }
      return reply.send({ success: true });
    }
    const row = await store.addMemory({
      organizationId,
      siteId,
      content: body!.data.content,
      createdBy: request.user?.id,
    });
    return reply.send(row);
  } catch (error) {
    request.log.error(error, "Failed to manage AI memory");
    return reply.status(500).send({ error: "Could not update project memory" });
  }
}

export { ANALYST_EXAMPLE_PROMPTS };
