// Structured request and runtime logging.
//
// One JSON object per line — `info` on stdout, `warn` and `error` on stderr,
// both of which Render's log drain ships to Better Stack. Field names are
// snake_case because that is what the fleet's log source already indexes.
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
import { monitorEventLoopDelay, performance, } from "node:perf_hooks";
const NS_PER_MS = 1_000_000;
const EVENT_LOOP_SAMPLE_MS = 60_000;
/** A request took at least this long → the line is emitted at `warn`. */
const SLOW_REQUEST_MS = 1_000;
/** Event-loop stall at least this long in a sample window → `warn`. */
const EVENT_LOOP_STALL_MS = 500;
function requestHeader(req, name) {
    const value = req.get(name);
    return value ? value.slice(0, 200) : undefined;
}
/** The deployed commit, short — the same value every app reports as `build` on /health. */
export function buildSha() {
    return (process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7);
}
/** Envelope keys a caller must not be able to overwrite. */
const RESERVED_FIELDS = new Set([
    "timestamp",
    "level",
    "event",
    "build",
    "service_id",
    "instance_id",
]);
/**
 * A JSON replacer that cannot throw on the values apps actually pass.
 *
 * `JSON.stringify` throws on a BigInt and on a circular reference, and
 * `logEvent` is called from places where a throw is catastrophic rather than
 * annoying: inside a `res.once("finish")` listener (Express cannot catch it —
 * the response is already sent — so it becomes an uncaughtException and kills
 * the server) and inside `runTrackedJob` before the work starts (the job then
 * silently never runs, and the only evidence is a heartbeat expiring hours
 * later). Both were reproduced.
 */
function safeReplacer() {
    const seen = new WeakSet();
    return function replacer(_key, value) {
        if (typeof value === "bigint")
            return `${value}n`;
        if (typeof value === "object" && value !== null) {
            if (seen.has(value))
                return "[circular]";
            seen.add(value);
        }
        return value;
    };
}
/** Serialize, degrading rather than throwing if a value is still hostile. */
function stringifyOrDegrade(payload) {
    try {
        return JSON.stringify(payload, safeReplacer()) ?? "{}";
    }
    catch {
        // Something exotic survived the replacer — a throwing toJSON, most likely.
        // Keep the envelope and drop only the offending values, so the line still
        // says what happened and where.
        const safe = {};
        let dropped = 0;
        for (const [key, value] of Object.entries(payload)) {
            try {
                JSON.stringify(value, safeReplacer());
                safe[key] = value;
            }
            catch {
                dropped += 1;
            }
        }
        if (dropped > 0)
            safe.unserializable_fields = dropped;
        try {
            return JSON.stringify(safe) ?? "{}";
        }
        catch {
            return `{"level":"error","event":"log_event_failed"}`;
        }
    }
}
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
export function logEvent(level, event, fields = {}) {
    const payload = {
        timestamp: new Date().toISOString(),
        level,
        event,
        build: buildSha(),
        service_id: process.env.RENDER_SERVICE_ID,
        instance_id: process.env.RENDER_INSTANCE_ID,
    };
    for (const [key, value] of Object.entries(fields)) {
        payload[RESERVED_FIELDS.has(key) ? `field_${key}` : key] = value;
    }
    const line = stringifyOrDegrade(payload);
    if (level === "info")
        console.log(line);
    else
        console.error(line);
}
/**
 * The request id for a request, once installRequestTelemetry has run.
 *
 * Use it when logging anything about the request in progress, so an error line
 * can be joined to its `http_request` line.
 */
export function requestId(res) {
    const value = res.locals?.requestId;
    return typeof value === "string" ? value : undefined;
}
export function installRequestTelemetry(app, options = {}) {
    const quiet = new Set(options.ignoreSuccessfulPaths ?? ["/health"]);
    app.use((req, res, next) => {
        const started = performance.now();
        const id = requestHeader(req, "x-request-id") || crypto.randomUUID();
        res.setHeader("X-Request-ID", id);
        res.locals.requestId = id;
        // `finish` fires when a response completes; `close` fires when the socket
        // closes, completed or not. Listening only for `finish` meant a client that
        // disconnected mid-response logged NOTHING AT ALL — client timeouts,
        // Cloudflare 524s and load-balancer drops, i.e. precisely the failures most
        // likely to be invisible, stayed invisible. Whichever fires first wins;
        // `settled` stops the other producing a duplicate.
        let settled = false;
        const emit = () => {
            if (settled)
                return;
            settled = true;
            const aborted = !res.writableFinished;
            const durationMs = Number((performance.now() - started).toFixed(1));
            if (!aborted && quiet.has(req.path) && res.statusCode < 400)
                return;
            const slow = durationMs >= SLOW_REQUEST_MS;
            const level = aborted || slow || res.statusCode >= 500 ? "warn" : "info";
            logEvent(level, "http_request", {
                request_id: id,
                cf_ray: requestHeader(req, "cf-ray"),
                method: req.method,
                path: req.path,
                // On an abort the status is what we intended to send, not what arrived.
                status: res.statusCode,
                duration_ms: durationMs,
                ...(aborted ? { aborted: true } : {}),
            });
        };
        res.once("finish", emit);
        res.once("close", emit);
        next();
    });
}
/**
 * A `node_runtime` sample every minute: event-loop delay, utilization, memory.
 *
 * The timer is unref'd, so it never holds the process open on shutdown.
 */
export function startRuntimeTelemetry() {
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    let previousUtilization = performance.eventLoopUtilization();
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
