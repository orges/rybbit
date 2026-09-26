import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { clickhouseQuery } from "../../db/clickhouse/clickhouse.js";
import { getSitesUserHasAccessTo } from "../../lib/auth-utils.js";
import {
  MAX_CUSTOM_QUERY_LENGTH,
  normalizeCustomQuery,
  sanitizeClickhouseError,
  validateScopedQuery,
} from "./utils/customQueryValidation.js";

// Mirrors the rybbit_query ClickHouse profile (docker-compose clickhouse_user_settings).
const MAX_EXECUTION_TIME_SECONDS = 10;
const MAX_RESULT_ROWS = 1000;

const requestBodySchema = z.object({
  query: z.string().trim().min(1).max(MAX_CUSTOM_QUERY_LENGTH),
  // When provided, scope scoped_events to this single site (the per-site Query
  // page). Omitted → query spans every site the caller can access in the org.
  siteId: z.number().int().positive().optional(),
});

/**
 * The one table a caller may read. Tenancy is decided here, by the wrapper, and
 * not by the query text: a single-site scope selects from `events` with the
 * site's own id as a bound parameter, so no query can widen it.
 *
 * A single-site scope also drops `site_id` from the projection. The rows are
 * already that one site, so naming it could only mislead — `site_id = <this
 * site>` silently re-filters, and `site_id = <another tenant>` matches nothing
 * and reads as "that site has no traffic", a confident answer about a tenant the
 * caller was never allowed to ask about. Without the column both are a loud
 * UNKNOWN_IDENTIFIER. An org-wide scope keeps the column, where filtering by
 * site is the whole point of the query.
 */
function scopedEventsCte(siteIds: number[]): string {
  const columns = siteIds.length === 1 ? "* EXCEPT (site_id)" : "*";
  return `SELECT ${columns} FROM events PREWHERE site_id IN {siteIds:Array(UInt16)}`;
}

export async function executeScopedQuery(query: string, siteIds: number[]) {
  const validationError = validateScopedQuery(query);
  if (validationError) throw new Error(validationError);

  const result = await clickhouseQuery.query({
    query: `WITH scoped_events AS (
      ${scopedEventsCte(siteIds)}
    ) SELECT * FROM (${normalizeCustomQuery(query)}) LIMIT {limit:UInt32}`,
    format: "JSONEachRow",
    query_params: { siteIds, limit: MAX_RESULT_ROWS },
  });
  return { data: await result.json<Record<string, unknown>>(), queryId: result.query_id };
}

export async function runCustomQuery(
  request: FastifyRequest<{
    Params: {
      organizationId: string;
    };
    Body: unknown;
  }>,
  reply: FastifyReply
) {
  const body = requestBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.status(400).send({ error: body.error.errors[0]?.message ?? "Invalid request body" });
  }

  const validationError = validateScopedQuery(body.data.query);
  if (validationError) {
    return reply.status(400).send({ error: validationError });
  }

  const userSites = await getSitesUserHasAccessTo(request);
  const accessibleSiteIds = userSites
    .filter(site => site.organizationId === request.params.organizationId)
    .map(site => site.siteId);

  if (accessibleSiteIds.length === 0) {
    return reply.status(403).send({ error: "No access to organization or no sites found" });
  }

  let siteIds = accessibleSiteIds;
  if (body.data.siteId !== undefined) {
    if (!accessibleSiteIds.includes(body.data.siteId)) {
      return reply.status(403).send({ error: "No access to the requested site" });
    }
    siteIds = [body.data.siteId];
  }

  try {
    const { data, queryId } = await executeScopedQuery(body.data.query, siteIds);
    return reply.send({
      data,
      meta: {
        queryId,
        rowCount: data.length,
        maxExecutionTimeSeconds: MAX_EXECUTION_TIME_SECONDS,
        maxRows: MAX_RESULT_ROWS,
      },
    });
  } catch (error) {
    request.log.error(error, "Failed to run custom analytics query");
    return reply.status(400).send({ error: sanitizeClickhouseError(error) });
  }
}
