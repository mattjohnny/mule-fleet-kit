import type { Express } from "express";
/** An allow-listed error name, or "Error" for anything unrecognized. */
export declare function safeErrorName(error: unknown): string;
/**
 * Where the error came from: `file.ts:line`, from the first stack frame that is
 * the app's own code.
 *
 * Frames in node_modules and node: internals are skipped — the top frame of a
 * database error is inside the driver, which tells you nothing about your bug.
 * Absolute paths are trimmed to the last two segments, both because Render's
 * paths are long and identical across apps, and so a build path never becomes a
 * log field.
 *
 * Returns undefined rather than guessing when there is no usable stack.
 */
export declare function errorSite(error: unknown): string | undefined;
/** The two fields every error line carries. Safe to spread into any event. */
export declare function errorFields(error: unknown): Record<string, unknown>;
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
 */
export declare function installProcessErrorHandlers(): void;
