// @mule/fleet-kit — shared bricks for The Mule's app fleet.
//
// Shared observability and Render caller-attribution infrastructure.
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
export { buildSha, installRequestTelemetry, logEvent, redactPath, requestId, startRuntimeTelemetry, } from "./telemetry.js";
export { errorFields, errorSite, installErrorTelemetry, installProcessErrorHandlers, safeErrorName, } from "./errors.js";
export { pingHeartbeat, runTrackedJob, } from "./jobs.js";
export { installRenderCallerAttribution, } from "./caller-attribution.js";
