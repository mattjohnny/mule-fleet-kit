import type { Express, Response } from "express";
export declare function safeErrorName(error: unknown): string;
export declare function errorSite(error: unknown): string | undefined;
/**
 * The two fields every error line carries. Safe to spread into any event.
 *
 * This must never throw. It is called from inside the `uncaughtException`
 * handler, and a throw there is fatal in the ugliest possible way: the process
 * died with exit code 7, no structured line, and a raw stack on stderr — the
 * exact outcome this package exists to replace. Both helpers already guard
 * their own property reads; this is the belt to their braces.
 */
export declare function errorFields(error: unknown): Record<string, unknown>;
/**
 * The status an error is going to produce.
 *
 * `res.statusCode` is still 200 when an error handler runs — nothing has set it
 * yet, that is what the handler downstream is for. The first version read it
 * anyway and fell through to 500, so EVERY 4xx dispatched through `next(err)`
 * was logged as a server error: a 413 from the body parser, a 403 from an
 * authorization check, a 404 for a missing record. Across the fleet that is
 * thousands of client mistakes reported as server failures, and the
 * `app_error_5xx` alert is built on exactly that distinction.
 *
 * Express's own convention is `err.status` / `err.statusCode`, which body-parser,
 * http-errors and every app's error classes set. Read those first; only guess
 * 500 when nobody has said otherwise.
 *
 * EXPORTED FOR `installTerminalErrorHandler`, AND FOR NOTHING ELSE. The terminal
 * handler answers the caller with a status and this handler logs one; if the two
 * were derived separately they would drift, and a line reading `status: 403`
 * beside a caller who was told 500 makes the log source worse than no log at
 * all. One derivation, two callers. It stays out of `index.ts`: apps have no
 * business reading it, and a published export is a promise to keep it.
 */
export declare function intendedStatus(error: unknown, res: Response): number;
/**
 * Log an `unhandled_error` line for anything that reaches Express's error path.
 *
 * INSTALL THIS AFTER THE ROUTES AND BEFORE THE APP'S OWN ERROR HANDLER. It logs
 * and then calls next(err), so whatever already decides the response keeps
 * deciding it — this changes what you can see, never what the caller receives.
 *
 * If the response has already been sent, Express is unwinding a broken response
 * and only the log line is possible; next(err) still runs so the default handler
 * can destroy the socket.
 */
export declare function installErrorTelemetry(app: Express): void;
/**
 * Log process-level failures that no request owns.
 *
 * These are the failures job 3 in mule-fleet-docs was written about: the ones
 * that used to leave no evidence at all.
 *
 * ON CRASH SEMANTICS — this deliberately does not make a crashing app survive.
 * An app that continues after an uncaught exception is running with state it
 * cannot vouch for, and Render restarting it is the correct outcome. So the
 * handler logs and then exits non-zero, which is what Node would have done.
 *
 * The one subtlety: adding an `unhandledRejection` listener SUPPRESSES Node's
 * own crash-on-rejection. If an app already has a listener it owns that
 * decision, so we only log. If we are the only listener we must exit ourselves,
 * or installing telemetry would quietly turn a crashing app into a surviving
 * one — a monitoring change with a behaviour change hidden inside it.
 *
 * CALLING THIS TWICE IS A NO-OP — see `processHandlersInstalled` above, and
 * `foreignOwnerExists` below for who is allowed to take the crash off us.
 */
export declare function installProcessErrorHandlers(): void;
