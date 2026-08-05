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
export declare function pingHeartbeat(url: string | undefined, job: string): Promise<void>;
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
export declare function runTrackedJob<T>(job: string, run: () => Promise<T>, options?: TrackedJobOptions): Promise<T>;
