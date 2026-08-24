import type { Express } from "express";
/**
 * Install the fleet's terminal error handler. Two things happen here.
 *
 * 1. `x-powered-by` is disabled. Express advertises itself in a header on every
 *    response, which is a free hint to anyone scanning the fleet for a framework
 *    with a known advisory. It is turned off here rather than in fourteen app
 *    bootstraps because this is the call every app is adding anyway (job 26,
 *    cluster 4 in mule-fleet-docs). It applies to successful responses too — the
 *    setting is read per response, not per handler.
 *
 * 2. The terminal 4-arg error middleware is registered. It answers with the
 *    house JSON `{ "error": "..." }` and never emits `error.message` or
 *    `error.stack` — see `houseMessage`, and the file header for why nothing is
 *    logged here either.
 *
 * INSTALL IT LAST, after the routes, after `installErrorTelemetry`, and after
 * any error handler of the app's own. Express runs middleware in registration
 * order, so anything registered later than a handler that sends a response never
 * runs at all. An app that already has a terminal handler it wants to keep
 * simply does not call this.
 *
 * THE HEADERS-SENT BRANCH IS NOT A FORMALITY. When a route has already written
 * part of a response and then fails — a streamed export that throws halfway
 * through the rows — the status line is long gone, so there is nothing to answer
 * with. Calling `res.json()` there throws `ERR_HTTP_HEADERS_SENT`, and passing
 * the error on with `next(error)` hands it to Express's default handler, which
 * responds by printing the stack to stderr — unstructured, unredacted, straight
 * past every guarantee this package makes. Destroying the socket is the honest
 * outcome: the client gets a truncated response and knows the body is
 * incomplete, which is true, and nothing leaks on the way out.
 */
export declare function installTerminalErrorHandler(app: Express): void;
