import type { Express } from "express";
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
 */
export declare function installProcessErrorHandlers(): void;
