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

import type { Express, NextFunction, Request, Response } from "express";
import { logEvent, redactPath, requestId } from "./telemetry.js";

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

/**
 * A safe error name, or "Error" when the value cannot be vouched for.
 *
 * WHY THIS IS A SHAPE TEST AND NOT ONLY AN ALLOW-LIST. The allow-list came from
 * `@mule/portal-auth`, where the errors are AWS SDK and fetch failures with known
 * names. Applied fleet-wide it made the field useless: not one app's own error
 * class is on it — `DomainError`, `HttpError`, `ReportServiceError`,
 * `AuthorizationError`, `SheetQuotaError` — so every line read `error_name:
 * "Error"` and a routine "task not found" was indistinguishable from a crash.
 *
 * A class name is an identifier the programmer typed, not user data, so it is
 * safe to emit as long as it is genuinely an identifier. Anything carrying
 * spaces, punctuation, interpolated values or unusual length is a library
 * stuffing a message into `name`, and collapses to "Error". The allow-list is
 * kept for names that would otherwise fail the shape test.
 */
const MAX_ERROR_NAME = 48;

function looksLikeClassName(value: string): boolean {
  if (!value || value.length > MAX_ERROR_NAME) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    const isUnderscore = code === 95;
    if (!(isUpper || isLower || isDigit || isUnderscore)) return false;
  }
  // Must start with a letter — rules out "404" and similar stringified values.
  const first = value.charCodeAt(0);
  return (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
}

export function safeErrorName(error: unknown): string {
  let candidate = "";
  try {
    candidate =
      error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name || "")
        : "";
  } catch {
    // A throwing `name` getter or `toString`. See errorFields.
    return "Error";
  }
  if (SAFE_ERROR_NAMES.has(candidate)) return candidate;
  return looksLikeClassName(candidate) ? candidate : "Error";
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
 *
 * TWO BUGS LIVED HERE. Both are the reason this function now looks so paranoid,
 * and neither is hypothetical — a review reproduced both.
 *
 *   1. It selected frames with `stack.split("\n").slice(1)`, i.e. "everything
 *      after the first line is a frame". False: an error MESSAGE containing a
 *      newline occupies several lines, and any of them ending in `:digits:digits`
 *      was read as a frame and emitted. `new Error("import failed:\n" + csvRow)`
 *      put an e-mail address and a wage into the log — from the one function
 *      written to keep messages out of logs. The same hole let a caller FORGE a
 *      site by embedding a fake `    at (...)` line. Frames are now selected by
 *      shape (`at ` prefix), which a message line does not have.
 *   2. It matched `/([^\s()]+):(\d+):\d+\)?\s*$/`. `[^\s()]+` overlaps `\d+` and
 *      the trailing `\s*$` forces a retry from every start position, so match
 *      time was quadratic in line length: 19 KB took over a second, and a 60 KB
 *      value interpolated into an error message blocked the event loop for 12.8
 *      SECONDS — a denial of service reachable from any route that puts request
 *      text in a message. There is now no regular expression here at all; the
 *      location is parsed from the right in linear time.
 *
 * Everything is bounded before it is examined, because the input is attacker-
 * influenced: a stack can be arbitrarily long and Error.stackTraceLimit is not
 * ours to rely on.
 */
const MAX_STACK_LINES = 60;
const MAX_FRAME_CHARS = 400;

function isDigits(value: string): boolean {
  if (!value || value.length > 9) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/**
 * Pull `path:line:col` off the end of one frame without a regex.
 *
 * Scanning right-to-left for the last two colons is O(n) and cannot backtrack,
 * which is the whole point — see bug 2 above.
 */
function frameLocation(frame: string): { file: string; line: string } | undefined {
  let text = frame.trimEnd();
  if (text.endsWith(")")) text = text.slice(0, -1);

  const lastColon = text.lastIndexOf(":");
  if (lastColon <= 0) return undefined;
  const prevColon = text.lastIndexOf(":", lastColon - 1);
  if (prevColon <= 0) return undefined;

  if (!isDigits(text.slice(lastColon + 1))) return undefined;
  const lineNumber = text.slice(prevColon + 1, lastColon);
  if (!isDigits(lineNumber)) return undefined;

  let rawPath = text.slice(0, prevColon);
  const open = rawPath.lastIndexOf("(");
  if (open >= 0) rawPath = rawPath.slice(open + 1);
  if (rawPath.startsWith("file://")) rawPath = rawPath.slice("file://".length);

  const segments = rawPath.split(/[/\\]/).filter(Boolean);
  const file = segments.slice(-2).join("/");
  return file ? { file, line: lineNumber } : undefined;
}

/**
 * The frame section of a stack, with the header (`Name: message`) removed.
 *
 * Selecting frames by the `at ` prefix alone is NOT enough, because a message is
 * attacker-influenced and can contain `\n    at handler (/src/payroll.ts:9999:1)`
 * — which reads as a perfectly good frame and lets the one diagnostic this
 * package preserves be pointed at an innocent file. The message is therefore cut
 * off by length, wherever it sits in the header, before any frame is considered.
 *
 * If the message cannot be located and is multi-line, this refuses to guess and
 * returns nothing. A missing `error_site` costs a little debugging convenience;
 * a wrong or leaking one costs trust in every line the package emits.
 */
function stackBody(error: unknown, stack: string): string {
  let message = "";
  try {
    const raw = (error as { message?: unknown } | null)?.message;
    message = typeof raw === "string" ? raw : "";
  } catch {
    message = "";
  }

  if (message) {
    // The header is `${name}: ${message}`, so the message starts near the front.
    const at = stack.indexOf(message);
    if (at >= 0 && at <= 256) return stack.slice(at + message.length);
    if (message.includes("\n")) return "";
  }

  const firstNewline = stack.indexOf("\n");
  return firstNewline >= 0 ? stack.slice(firstNewline + 1) : "";
}

export function errorSite(error: unknown): string | undefined {
  let stack: string;
  try {
    stack =
      error && typeof error === "object" && "stack" in error
        ? String((error as { stack?: unknown }).stack || "")
        : "";
  } catch {
    // A throwing `stack` getter. Reading a foreign object cannot be allowed to
    // fail the logging of the very error we are trying to report.
    return undefined;
  }
  if (!stack) return undefined;

  const lines = stackBody(error, stack).split("\n", MAX_STACK_LINES);
  for (const line of lines) {
    // Frame lines are `    at fn (file:line:col)`.
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("at ")) continue;
    if (line.includes("node_modules") || line.includes("node:")) continue;

    const location = frameLocation(trimmed.slice(0, MAX_FRAME_CHARS));
    if (!location) continue;
    return `${location.file}:${location.line}`.slice(0, 120);
  }
  return undefined;
}

/**
 * The two fields every error line carries. Safe to spread into any event.
 *
 * This must never throw. It is called from inside the `uncaughtException`
 * handler, and a throw there is fatal in the ugliest possible way: the process
 * died with exit code 7, no structured line, and a raw stack on stderr — the
 * exact outcome this package exists to replace. Both helpers already guard
 * their own property reads; this is the belt to their braces.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  try {
    return { error_name: safeErrorName(error), error_site: errorSite(error) };
  } catch {
    return { error_name: "Error", error_fields_failed: true };
  }
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
/**
 * The status an error is going to produce.
 *
 * `res.statusCode` is still 200 when an error handler runs — nothing has set it
 * yet, that is what the handler downstream is for. The first version read it
 * anyway and fell through to 500, so EVERY 4xx dispatched through `next(err)`
 * was logged as a server error: a 413 from the body parser, a 403 from an
 * authorization check, a 404 for a missing record. Across the fleet that is
 * thousands of client mistakes reported as server failures, and the
 * `app_error_5xx` alert is built on exactly that distinction.
 *
 * Express's own convention is `err.status` / `err.statusCode`, which body-parser,
 * http-errors and every app's error classes set. Read those first; only guess
 * 500 when nobody has said otherwise.
 */
function intendedStatus(error: unknown, res: Response): number {
  const candidate = error as { status?: unknown; statusCode?: unknown } | null;
  for (const value of [candidate?.status, candidate?.statusCode]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  // A handler that already set a status (or already sent) is telling us directly.
  if (res.statusCode >= 400) return res.statusCode;
  return 500;
}

export function installErrorTelemetry(app: Express): void {
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    const status = intendedStatus(error, res);
    logEvent(status >= 500 ? "error" : "warn", "unhandled_error", {
      request_id: requestId(res),
      method: req.method,
      path: redactPath(req.path),
      status,
      headers_sent: res.headersSent,
      ...errorFields(error),
    });
    next(error);
  });
}

/**
 * One install per module instance.
 *
 * Two entry points that each call this — a server and a worker booted from the
 * same process, or a re-export imported from two places — used to register two
 * listeners each. The old ownership test counted listeners, so on a crash each
 * of our own handlers read the OTHER one as "somebody else is handling this":
 * both logged `fatal: false`, neither exited, and the app carried on serving on
 * state it had just declared untrustworthy. Reproduced.
 *
 * The count test is fixed below as well — the two defences are independent, and
 * this one is worth having on its own: duplicate listeners mean duplicate log
 * lines even when the exit is correct.
 */
let processHandlersInstalled = false;

/**
 * The mark that says "this listener is fleet-kit's".
 *
 * A plain string key, deliberately, and not a `Symbol`: a symbol is unique per
 * module instance, so two copies of this file loaded from two different paths
 * (an app and a dependency resolving `@mule/fleet-kit` separately, which npm
 * does routinely) would not recognise each other's listeners and we would be
 * back to the bug above. A well-known string is the only marker that survives
 * that, and it greps.
 */
const FATAL_LISTENER_MARKER = "__muleFleetKitFatal";

function markAsOurs<T extends (...args: never[]) => void>(listener: T): T {
  Object.defineProperty(listener, FATAL_LISTENER_MARKER, {
    value: true,
    enumerable: false,
  });
  return listener;
}

function isOursListener(listener: unknown): boolean {
  return (
    typeof listener === "function" &&
    (listener as unknown as Record<string, unknown>)[FATAL_LISTENER_MARKER] === true
  );
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
 *
 * CALLING THIS TWICE IS A NO-OP — see `processHandlersInstalled` above, and
 * `foreignOwnerExists` below for who is allowed to take the crash off us.
 */
export function installProcessErrorHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on(
    "unhandledRejection",
    markAsOurs((reason: unknown) => {
      handleFatal("unhandledRejection", "unhandled_rejection", reason);
    })
  );
  process.on(
    "uncaughtException",
    markAsOurs((error: unknown) => {
      handleFatal("uncaughtException", "uncaught_exception", error);
    })
  );
}

type FatalSignal = "unhandledRejection" | "uncaughtException";

/**
 * Is somebody OTHER THAN fleet-kit going to handle this crash?
 *
 * WHY NOT A LISTENER COUNT. `process.listenerCount(signal) > 1` was the first
 * answer and it cannot tell the two cases apart that matter:
 *
 *   "somebody else will exit the process"  → we must defer, or we hard-exit
 *                                            through their graceful shutdown.
 *   "somebody else also decided to defer"  → nobody exits at all.
 *
 * A second fleet-kit listener is the second case, and so is any third-party
 * log-only listener that a count reads as an owner. The question is not how many
 * listeners there are, it is whether any of them is a stranger. So each listener
 * we register carries a marker, and a foreign owner exists only when some
 * registered listener does not carry it. (Our own handler is marked too, which
 * is why there is no "…and is not me" clause: kin are skipped as a class.)
 *
 * The consequences, all three deliberate:
 *
 *   sole fleet-kit listener   → `fatal: true`, re-emit, exit 1. Unchanged.
 *   two fleet-kit instances   → each is kin to the other, so whichever runs
 *                               first still exits. Both may call `process.exit`;
 *                               the first wins and the second never runs. The
 *                               app never survives a crash by accident.
 *   a genuine foreign handler → `fatal: false`, no exit, exactly as before. The
 *                               app owns its own crash semantics; that is the
 *                               graceful-shutdown case this test exists for.
 */
function foreignOwnerExists(signal: FatalSignal): boolean {
  // `process.listeners` unwraps `once()` wrappers for us, so an app's
  // `process.once("uncaughtException", …)` is still seen as its own function.
  // The cast is only because process's typed overloads reject a union event
  // name; the runtime call is the ordinary one.
  const registered = process.listeners(signal as "uncaughtException") as unknown[];
  return registered.some((listener) => !isOursListener(listener));
}

/**
 * Log a process-level failure, then do exactly what Node would have done.
 *
 * OWNERSHIP IS DECIDED HERE, AT CRASH TIME — not at install time, which was a
 * bug. The README tells apps to install this "as early as possible", so an app's
 * own handler is normally registered *later*; reading the listener count during
 * install therefore never saw it, and this function hard-exited straight through
 * a graceful shutdown that had only just begun (flush metrics, close the
 * database, drain in-flight requests).
 *
 * WHO the other listeners are matters as much as how many, which counting could
 * not express — see foreignOwnerExists above.
 */
function handleFatal(
  signal: FatalSignal,
  event: string,
  error: unknown
): void {
  const ownedElsewhere = foreignOwnerExists(signal);

  logEvent("error", event, { ...errorFields(error), fatal: !ownedElsewhere });

  if (ownedElsewhere) return;

  // RE-EMIT THE ORIGINAL. Registering a handler for these signals suppresses
  // Node's own stack dump, so the first version of this file silently traded a
  // full `Error: SQLITE_CANTOPEN: unable to open database file /data/app.db`
  // plus stack for a line reading `error_name: "Error"` — and when every frame
  // is inside a dependency, `error_site` is absent too, leaving literally
  // nothing to debug a failed deploy with.
  //
  // This is not a new leak: Node prints this exact text today for an unhandled
  // throw, so printing it is the status quo and suppressing it was the change.
  // The no-messages rule governs the STRUCTURED lines, which are queried,
  // aggregated and shared; a fatal crash dump is read once by whoever is fixing
  // the outage. Keep the rule for `unhandled_error`, not for process death.
  console.error(error);

  // Exit immediately rather than after a flush delay. stdout/stderr writes to a
  // pipe are synchronous on Linux (Render) and Windows, so the delay bought no
  // durability — it only let the process keep accepting requests on state it
  // cannot vouch for, which is the opposite of this function's stated purpose.
  process.exit(1);
}
