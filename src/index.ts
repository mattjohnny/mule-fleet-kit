// @mule/fleet-kit — shared bricks for The Mule's app fleet.
//
// Shared observability and Render caller-attribution infrastructure.
//
// Wiring an app takes five calls. Order matters for three of them:
//
//   installProcessErrorHandlers();          // once, as early as possible
//   startRuntimeTelemetry();                // once, anywhere after that
//   installRequestTelemetry(app);           // BEFORE the routes
//   ... your routes ...
//   installErrorTelemetry(app);             // AFTER the routes, BEFORE any
//                                          // error handler
//   ... your own error handlers, if any ...
//   installTerminalErrorHandler(app);       // LAST — it answers the caller
//
// An app that wants to keep its own terminal handler just does not make the
// last call; everything above it is unaffected.
//
// Render-hosted apps install caller attribution once, before their limiters:
//
//   const callerKey = installRenderCallerAttribution(app, {
//     probeKey: process.env.RATE_LIMIT_PROBE_KEY,
//   });
//
// And for each scheduled job:
//
//   await runTrackedJob("nightly-roster", () => captureRoster(), {
//     heartbeatUrl: process.env.ROSTER_HEARTBEAT_URL,
//   });

export {
  buildSha,
  installRequestTelemetry,
  logEvent,
  redactPath,
  requestId,
  startRuntimeTelemetry,
  type LogLevel,
} from "./telemetry.js";

export {
  errorFields,
  errorSite,
  installErrorTelemetry,
  installProcessErrorHandlers,
  safeErrorName,
} from "./errors.js";

export { installTerminalErrorHandler } from "./terminal-error.js";

export {
  pingHeartbeat,
  runTrackedJob,
  type TrackedJobOptions,
} from "./jobs.js";

export {
  installRenderCallerAttribution,
  type CallerKey,
  type RenderCallerAttributionOptions,
} from "./caller-attribution.js";
