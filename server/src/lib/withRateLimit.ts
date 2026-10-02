/**
 * Attaches a per-route rate-limit cap to an existing auth pre-handler chain.
 *
 * The pre-handler array is copied rather than shared. @fastify/rate-limit pushes
 * its hook onto whichever array it finds on the route, so several routes built
 * from one base chain (`orgSqlRead` and friends are single objects reused across
 * a dozen routes) would otherwise all end up running every cap — and whichever
 * was declared first set the limit for all of them. That is not a theoretical
 * hazard: the analyst's 10/min silently ran at 60/min because a 60/min route was
 * registered first, and nothing errored.
 */
export function withRateLimit<T extends { preHandler: unknown }>(
  opts: T,
  limit: { max: number; timeWindow: string }
): T & { config: { rateLimit: { max: number; timeWindow: string } } } {
  return {
    ...opts,
    preHandler: Array.isArray(opts.preHandler) ? [...opts.preHandler] : opts.preHandler,
    config: { rateLimit: limit },
  };
}
