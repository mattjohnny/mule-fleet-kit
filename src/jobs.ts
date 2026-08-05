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

export interface TrackedJobOptions {
  /**
   * Better Stack heartbeat URL, pinged only on success. Falsy → no ping.
   *
   * Read this from the environment at the CALL SITE rather than at module load,
   * so a missing variable is visible in the app's own config code.
   */
  heartbeatUrl?: string;
  /** Extra fields for the job's log lines. Same hygiene rules as logEvent. */
  fields?: Record<string, unknown>;
}

/**
 * Ping a heartbeat URL. Never throws, never rejects.
 *
 * A monitoring call that can break the thing it monitors is worse than no
 * monitoring, so every failure here is swallowed into a warn line. A failed ping
 * is not silent, though: the heartbeat itself goes down, which is the alert.
 */
export async function pingHeartbeat(url: string | undefined, job: string): Promise<void> {
  if (!url) return;
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!response.ok) {
      logEvent("warn", "heartbeat_ping_failed", { job, status: response.status });
    }
  } catch (error) {
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
 */
export async function runTrackedJob<T>(
  job: string,
  run: () => Promise<T>,
  options: TrackedJobOptions = {}
): Promise<T> {
  const fields = { job, ...options.fields };
  const started = Date.now();
  logEvent("info", "job_started", fields);

  try {
    const result = await run();
    logEvent("info", "job_finished", { ...fields, duration_ms: Date.now() - started });
    await pingHeartbeat(options.heartbeatUrl, job);
    return result;
  } catch (error) {
    logEvent("error", "job_failed", {
      ...fields,
      duration_ms: Date.now() - started,
      ...errorFields(error),
    });
    throw error;
  }
}
