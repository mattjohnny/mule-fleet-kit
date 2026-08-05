import type { Express, Response } from "express";
export type LogLevel = "info" | "warn" | "error";
/** The deployed commit, short — the same value every app reports as `build` on /health. */
export declare function buildSha(): string;
/**
 * Emit one structured line.
 *
 * `error` and `warn` go to stderr and stdout respectively, matching what the
 * platform expects, so a level is never inferred from the stream alone.
 *
 * Callers own the contents of `fields`. Do not pass request bodies, headers,
 * cookies, query strings, e-mail addresses, or anything derived from a
 * credential — read the header comment before adding a field.
 */
export declare function logEvent(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
/**
 * The request id for a request, once installRequestTelemetry has run.
 *
 * Use it when logging anything about the request in progress, so an error line
 * can be joined to its `http_request` line.
 */
export declare function requestId(res: Response): string | undefined;
/**
 * One `http_request` line per finished response, and an `X-Request-ID` header.
 *
 * Install this BEFORE the routes — Express runs middleware in registration
 * order, and a response that finishes inside an earlier handler never reaches a
 * later one.
 *
 * An inbound `X-Request-ID` is honoured so a chain of calls shares one id. It is
 * length-capped and never parsed, so a hostile value is a nuisance at worst, but
 * it does mean the id is caller-controlled and not proof of anything.
 */
export declare function installRequestTelemetry(app: Express): void;
/**
 * A `node_runtime` sample every minute: event-loop delay, utilization, memory.
 *
 * The timer is unref'd, so it never holds the process open on shutdown.
 */
export declare function startRuntimeTelemetry(): () => void;
