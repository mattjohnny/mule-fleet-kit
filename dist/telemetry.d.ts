import type { Express, Response } from "express";
export type LogLevel = "info" | "warn" | "error";
/** The deployed commit, short — the same value every app reports as `build` on /health. */
export declare function buildSha(): string;
/**
 * Emit one structured line.
 *
 * STREAMS: `info` goes to stdout; `warn` and `error` both go to stderr, because
 * Node's `console.warn` is an alias for `console.error`. An earlier version of
 * this comment claimed warn went to stdout, and the test asserted that claim by
 * defining the mapping it then checked — so the docs, the test and the code all
 * agreed with each other and none of them agreed with Node.
 *
 * Callers own the contents of `fields`. Do not pass request bodies, headers,
 * cookies, query strings, e-mail addresses, or anything derived from a
 * credential — read the header comment before adding a field. Envelope keys are
 * protected: a caller field named `level` or `event` is prefixed rather than
 * applied, so a log line can never contradict the stream it was written to.
 */
export declare function logEvent(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
/**
 * The request id for a request, once installRequestTelemetry has run.
 *
 * Use it when logging anything about the request in progress, so an error line
 * can be joined to its `http_request` line.
 */
export declare function requestId(res: Response): string | undefined;
/** Replace secret-looking path segments with `:id`. */
export declare function redactPath(path: string): string;
export interface RequestTelemetryOptions {
    /**
     * Paths whose SUCCESSFUL responses produce no line. Failures on these paths
     * are always logged. Defaults to the health endpoint.
     *
     * This is not tidiness. On the one app that ran this telemetry in production,
     * `/health` produced 14,701 lines in 24 hours against 206 for `/api/*` — 98.3%
     * of the volume, on a platform that bills by volume, burying every line that
     * mattered. `mule-labour-live` had already reached that conclusion
     * independently and excluded `/health` in its own logger; adopting this
     * package would have silently reverted that decision.
     *
     * Successful health checks are the definition of uninteresting: the uptime
     * monitor already records them, once per app rather than once per probe. A
     * FAILING health check is very interesting, so it still gets logged.
     */
    ignoreSuccessfulPaths?: string[];
}
/**
 * One `http_request` line per response — finished OR aborted — and an
 * `X-Request-ID` header.
 *
 * Install this BEFORE the routes, and before the body parsers: Express runs
 * middleware in registration order, so a request rejected for an oversized
 * payload never reaches anything registered later, and that 413 is exactly the
 * one worth seeing.
 *
 * An inbound `X-Request-ID` is honoured so a chain of calls shares one id. It is
 * length-capped and never parsed, so a hostile value is a nuisance at worst, but
 * it does mean the id is caller-controlled and not proof of anything.
 *
 * Logged paths are passed through `redactPath`, so a capability token sitting in
 * a path segment does not reach the log source.
 */
export declare function installRequestTelemetry(app: Express, options?: RequestTelemetryOptions): void;
/**
 * A `node_runtime` sample every minute: event-loop delay, utilization, memory.
 *
 * The timer is unref'd, so it never holds the process open on shutdown.
 */
export declare function startRuntimeTelemetry(): () => void;
