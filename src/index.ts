// @mule/fleet-kit — shared bricks for The Mule's app fleet.
//
// First brick: observability. See mule-fleet-docs/jobs.md §3.
//
// Wiring an app takes four calls. Order matters for two of them:
//
//   installProcessErrorHandlers();          // once, as early as possible
//   startRuntimeTelemetry();                // once, anywhere after that
//   installRequestTelemetry(app);           // BEFORE the routes
//   ... your routes ...
//   installErrorTelemetry(app);             // AFTER the routes, BEFORE your own
//                                          // error handler
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

export {
  pingHeartbeat,
  runTrackedJob,
  type TrackedJobOptions,
} from "./jobs.js";
