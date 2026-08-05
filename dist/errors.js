// Error telemetry.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: an error's *message* is never logged.
//
// That looks like throwing away the useful half, so the reasoning is worth
// keeping. Error messages in this fleet routinely carry credentials,
// session-bearing URLs, and personal data quoted straight out of the database —
// connector, auth and database failures each leak a different one of those. The
// convention started in @mule/portal-auth's safe-error.ts and this is the
// fleet-wide version of it.
//
// What is logged instead is an allow-listed error NAME plus the code LOCATION —
// "TypeError at src/db.ts:412". A file and a line number are facts about the
// program, not about anyone's data, and joined to a `request_id` they are enough
// to find the fault. If you need the message, reproduce it locally.
//
// (When @mule/portal-auth next moves, its copy should import from here. Two
// copies in shared packages beats fourteen copies in apps, which is the drift
// this package exists to end.)
import { logEvent, requestId } from "./telemetry.js";
const SAFE_ERROR_NAMES = new Set([
    "AbortError",
    "AccessDeniedException",
    "AggregateError",
    "DecryptionFailure",
    "Error",
    "EvalError",
    "InternalFailure",
    "InternalServiceError",
    "InvalidParameterException",
    "InvalidRequestException",
    "NetworkingError",
    "RangeError",
    "ReferenceError",
    "RequestTimeout",
    "ResourceNotFoundException",
    "ServiceUnavailableException",
    "SyntaxError",
    "ThrottlingException",
    "TimeoutError",
    "TooManyRequestsException",
    "TypeError",
    "URIError",
]);
/** An allow-listed error name, or "Error" for anything unrecognized. */
export function safeErrorName(error) {
    const candidate = error && typeof error === "object" && "name" in error
        ? String(error.name || "")
        : "";
    return SAFE_ERROR_NAMES.has(candidate) ? candidate : "Error";
}
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
export function errorSite(error) {
    const stack = error && typeof error === "object" && "stack" in error
        ? String(error.stack || "")
        : "";
    if (!stack)
        return undefined;
    for (const line of stack.split("\n").slice(1)) {
        if (line.includes("node_modules") || line.includes("node:"))
            continue;
        // Frames end in (path:line:col) or are a bare path:line:col.
        const match = line.match(/([^\s()]+):(\d+):\d+\)?\s*$/);
        if (!match)
            continue;
        const [, rawPath, lineNumber] = match;
        const segments = rawPath.replace(/^file:\/\//, "").split(/[/\\]/);
        const file = segments.slice(-2).join("/");
        if (!file)
            continue;
        return `${file}:${lineNumber}`.slice(0, 120);
    }
    return undefined;
}
/** The two fields every error line carries. Safe to spread into any event. */
export function errorFields(error) {
    return { error_name: safeErrorName(error), error_site: errorSite(error) };
}
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
export function installErrorTelemetry(app) {
    app.use((error, req, res, next) => {
        logEvent("error", "unhandled_error", {
            request_id: requestId(res),
            method: req.method,
            path: req.path,
            status: res.statusCode >= 400 ? res.statusCode : 500,
            headers_sent: res.headersSent,
            ...errorFields(error),
        });
        next(error);
    });
}
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
export function installProcessErrorHandlers() {
    const rejectionOwnedElsewhere = process.listenerCount("unhandledRejection") > 0;
    const exceptionOwnedElsewhere = process.listenerCount("uncaughtException") > 0;
    process.on("unhandledRejection", (reason) => {
        logEvent("error", "unhandled_rejection", {
            ...errorFields(reason),
            fatal: !rejectionOwnedElsewhere,
        });
        if (!rejectionOwnedElsewhere)
            exitAfterFlush();
    });
    process.on("uncaughtException", (error) => {
        logEvent("error", "uncaught_exception", {
            ...errorFields(error),
            fatal: !exceptionOwnedElsewhere,
        });
        if (!exceptionOwnedElsewhere)
            exitAfterFlush();
    });
}
/**
 * Exit non-zero, giving stdout one turn of the event loop to drain first.
 *
 * console.log to a pipe is asynchronous, and Render's log collector reads a
 * pipe. Calling process.exit() in the same tick as the write is the classic way
 * to lose exactly the line that explains the crash.
 *
 * The timer is deliberately NOT unref'd. An unref'd timer does not hold the
 * process open, so a worker whose event loop had nothing else left would exit 0
 * — reporting success for the run that just crashed.
 */
function exitAfterFlush() {
    setTimeout(() => process.exit(1), 100);
}
