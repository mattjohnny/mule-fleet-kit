// Background-job telemetry and heartbeats.
//
// This is the half of job 3 that logging alone cannot cover. An unhandled error
// shows up as a 500; a nightly job that silently never runs produces no error,
// no 5xx and no downtime — nothing to alert on. The only way to see it is to
// notice the ABSENCE of a success signal, which is what a heartbeat is:
// the job pings a URL when it finishes, and the monitor raises an incident when
// a ping does not arrive in time.
//
// Set <APP>_HEARTBEAT_URL (or pass the url) per job. With no url configured
// everything here still runs and still logs; only the ping is skipped, so an app
// works unconfigured and locally.
import { errorFields } from "./errors.js";
import { logEvent } from "./telemetry.js";
const PING_TIMEOUT_MS = 10_000;
/**
 * Ping a heartbeat URL. Never throws, never rejects.
 *
 * A monitoring call that can break the thing it monitors is worse than no
 * monitoring, so every failure here is swallowed into a warn line. A failed ping
 * is not silent, though: the heartbeat itself goes down, which is the alert.
 */
export async function pingHeartbeat(url, job) {
    if (!url)
        return;
    try {
        const response = await fetch(url, {
            method: "POST",
            // A heartbeat host that starts redirecting must not be able to report
            // health via whatever it redirects to. `manual` makes a 3xx a non-ok
            // response, which is what it is.
            redirect: "manual",
            signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        if (!response.ok) {
            logEvent("warn", "heartbeat_ping_failed", { job, status: response.status });
        }
    }
    catch (error) {
        // The URL carries a heartbeat token, so it is never logged — only the fact.
        logEvent("warn", "heartbeat_ping_failed", { job, ...errorFields(error) });
    }
}
/**
 * Run a background job with a start line, an end line, and a heartbeat on success.
 *
 * Emits `job_started`, then either `job_finished` (info, with duration_ms) or
 * `job_failed` (error, with the safe error name and site). The heartbeat is
 * pinged ONLY on success — a job that ran and threw must not look alive, or the
 * heartbeat would report health for a job that never does its work.
 *
 * The original error is always re-thrown. This observes a job; it does not
 * change whether a failure propagates.
 *
 * ⚠ THE JOB MUST ACTUALLY REJECT WHEN IT FAILS. This is the sharpest edge in the
 * package, and it drew blood on first use: `mule-workback`'s backup already
 * caught its own failures internally and resolved anyway, so wrapping it here
 * produced `job_finished` and a GREEN HEARTBEAT for backups that never happened
 * — a monitoring system reporting health for the exact failure it was installed
 * to catch. Wrapping a function whose contract is "never throws" buys nothing
 * and actively lies.
 *
 * Before wrapping, read the function. If it swallows, either make it re-throw or
 * have it return a result the caller checks and rejects on. If you cannot, pass
 * no `heartbeatUrl` — the log lines are still worth having, and an absent
 * heartbeat is honest where a green one is not.
 */
export async function runTrackedJob(job, run, options = {}) {
    const fields = { job, ...options.fields };
    const started = Date.now();
    logEvent("info", "job_started", fields);
    try {
        const result = await run();
        logEvent("info", "job_finished", { ...fields, duration_ms: Date.now() - started });
        await pingHeartbeat(options.heartbeatUrl, job);
        return result;
    }
    catch (error) {
        logEvent("error", "job_failed", {
            ...fields,
            duration_ms: Date.now() - started,
            ...errorFields(error),
        });
        throw error;
    }
}
