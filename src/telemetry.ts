// Structured request and runtime logging.
//
// One JSON object per line on stdout, which is what Render's log drain ships to
// Better Stack. Field names are snake_case because that is what the fleet's log
// source already indexes.
//
// WHAT IS DELIBERATELY NOT LOGGED, and why — see also the log-hygiene rule in
// mule-fleet-docs/standards.md:
//
//   the query string   `req.path`, never `req.originalUrl`. Query strings in this
//                      fleet carry e-mail addresses (`?email=`), and a log line is
//                      a far more copied artifact than a URL bar.
//   headers, cookies   no allow-list is worth the risk here; the session cookie
//                      and the Portal's tokens both travel in them.
//   the request body    same reason, plus it is where staff names and wages live.
//
// `cf_ray` is the exception: it is Cloudflare's own opaque request id, holds no
// personal data, and is the only way to line a log line up with Cloudflare's view
// of the same request.

import crypto from "node:crypto";
import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
} from "node:perf_hooks";
import type { Express, Request, Response } from "express";

const NS_PER_MS = 1_000_000;
const EVENT_LOOP_SAMPLE_MS = 60_000;

/** A request took at least this long → the line is emitted at `warn`. */
const SLOW_REQUEST_MS = 1_000;

/** Event-loop stall at least this long in a sample window → `warn`. */
const EVENT_LOOP_STALL_MS = 500;

export type LogLevel = "info" | "warn" | "error";

function requestHeader(req: Request, name: string): string | undefined {
  const value = req.get(name);
  return value ? value.slice(0, 200) : undefined;
}

/** The deployed commit, short — the same value every app reports as `build` on /health. */
export function buildSha(): string {
  return (process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7);
}

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
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    build: buildSha(),
    service_id: process.env.RENDER_SERVICE_ID,
    instance_id: process.env.RENDER_INSTANCE_ID,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * The request id for a request, once installRequestTelemetry has run.
 *
 * Use it when logging anything about the request in progress, so an error line
 * can be joined to its `http_request` line.
 */
export function requestId(res: Response): string | undefined {
  const value = res.locals?.requestId;
  return typeof value === "string" ? value : undefined;
}

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
export function installRequestTelemetry(app: Express): void {
  app.use((req, res, next) => {
    const started = performance.now();
    const id = requestHeader(req, "x-request-id") || crypto.randomUUID();
    res.setHeader("X-Request-ID", id);
    res.locals.requestId = id;

    res.once("finish", () => {
      const durationMs = Number((performance.now() - started).toFixed(1));
      const level: LogLevel =
        durationMs >= SLOW_REQUEST_MS || res.statusCode >= 500 ? "warn" : "info";
      logEvent(level, "http_request", {
        request_id: id,
        cf_ray: requestHeader(req, "cf-ray"),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: durationMs,
      });
    });

    next();
  });
}

/**
 * A `node_runtime` sample every minute: event-loop delay, utilization, memory.
 *
 * The timer is unref'd, so it never holds the process open on shutdown.
 */
export function startRuntimeTelemetry(): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previousUtilization: EventLoopUtilization = performance.eventLoopUtilization();

  const timer = setInterval(() => {
    const utilization = performance.eventLoopUtilization(previousUtilization);
    previousUtilization = performance.eventLoopUtilization();
    const maxMs = delay.max / NS_PER_MS;
    const memory = process.memoryUsage();

    logEvent(maxMs >= EVENT_LOOP_STALL_MS ? "warn" : "info", "node_runtime", {
      event_loop_p50_ms: Number((delay.percentile(50) / NS_PER_MS).toFixed(1)),
      event_loop_p95_ms: Number((delay.percentile(95) / NS_PER_MS).toFixed(1)),
      event_loop_max_ms: Number(maxMs.toFixed(1)),
      event_loop_utilization: Number(utilization.utilization.toFixed(4)),
      rss_mb: Number((memory.rss / 1024 / 1024).toFixed(1)),
      heap_used_mb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    });
    delay.reset();
  }, EVENT_LOOP_SAMPLE_MS);

  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
