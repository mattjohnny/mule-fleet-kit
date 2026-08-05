# @mule/fleet-kit

Shared bricks for The Mule's app fleet. First brick: **observability** — structured
logging, error telemetry, and background-job heartbeats.

Built for [`mule-fleet-docs`](https://github.com/mattjohnny/mule-fleet-docs) job 3.
The alerting side of that job (Better Stack log source, `/health` monitors, the
`app_error_5xx` alert) is already live and needs no app code; this package is the
in-app half.

## Install

```bash
npm install github:mattjohnny/mule-fleet-kit#v0.1.0
```

Pin the tag, the way apps pin `@mule/portal-auth`. Never track `main` — a shared
dependency that moves on its own turns one bad commit into fourteen incidents.

## Wiring an app

Four calls. **Order matters for two of them**, because Express runs middleware in
registration order.

```ts
import {
  installProcessErrorHandlers,
  installRequestTelemetry,
  installErrorTelemetry,
  startRuntimeTelemetry,
} from "@mule/fleet-kit";

installProcessErrorHandlers();   // once, as early as possible
startRuntimeTelemetry();         // once, any time after

const app = express();
installRequestTelemetry(app);    // BEFORE the routes

// ... routes ...

installErrorTelemetry(app);      // AFTER the routes, BEFORE your own error handler
```

`installRequestTelemetry` after the routes sees nothing — a response that finishes
in an earlier handler never reaches a later one. `installErrorTelemetry` after
your own error handler also sees nothing, for the same reason: whichever handler
sends the response ends the chain.

### Background jobs

```ts
import { runTrackedJob } from "@mule/fleet-kit";

await runTrackedJob("nightly-roster", () => captureRoster(), {
  heartbeatUrl: process.env.ROSTER_HEARTBEAT_URL,
});
```

Emits `job_started`, then `job_finished` or `job_failed`, and pings the heartbeat
**only on success**. With no `heartbeatUrl` it still logs and just skips the ping,
so an app runs unconfigured and locally.

Create the heartbeat in Better Stack, set its period to the job's schedule plus
slack, and put its URL in the app's environment. **Leave it paused until the ping
is deployed** — an unpaused heartbeat with nothing pinging it raises an incident
as soon as its period elapses.

## Events

| event | level | when |
| --- | --- | --- |
| `http_request` | info, `warn` at ≥1s or 5xx | every finished response |
| `node_runtime` | info, `warn` on a ≥500ms stall | every 60s |
| `unhandled_error` | error | anything reaching Express's error path |
| `unhandled_rejection` | error | a promise rejection nobody caught |
| `uncaught_exception` | error | a throw nobody caught |
| `job_started` / `job_finished` | info | `runTrackedJob` |
| `job_failed` | error | `runTrackedJob`, then re-thrown |
| `heartbeat_ping_failed` | warn | the ping failed; the heartbeat itself is the alert |

Every line carries `timestamp`, `level`, `event`, `build`, `service_id` and
`instance_id`. Request-scoped lines carry `request_id`; use `requestId(res)` to
put it on your own lines so they join up.

## Two rules with teeth

**Error messages are never logged.** Only an allow-listed error *name* plus a code
location — `TypeError at src/db.ts:412`. Messages in this fleet routinely carry
credentials, session-bearing URLs, and personal data quoted straight out of the
database. The convention started in `@mule/portal-auth`'s
`safe-error.ts`; this is the fleet-wide version. If you need the message,
reproduce it locally.

**Query strings are never logged.** Lines carry `req.path`, never
`req.originalUrl`. `?email=` is a real pattern in this fleet, and a log line gets
copied far more than a URL bar does.

Both are covered by tests that assert the sensitive value is absent from the
emitted JSON, so a regression fails CI rather than quietly shipping.

## Crash semantics

`installProcessErrorHandlers` does **not** make a crashing app survive. An app
that continues after an uncaught exception is running on state it cannot vouch
for, and Render restarting it is the right outcome — so it logs, then exits
non-zero, which is what Node would have done anyway.

One subtlety it handles: adding an `unhandledRejection` listener *suppresses*
Node's own crash-on-rejection. If your app already has a listener, it owns that
decision and this only logs. If not, this exits — otherwise adding telemetry
would quietly convert a crashing app into a surviving one, which is a behaviour
change smuggled inside a monitoring change.

## Development

```bash
npm ci
npm run typecheck
npm test          # builds, then runs node:test against dist
```

`dist/` is committed — consumers install the repo as-is. CI fails if it drifts
from `src/`. Run `npm run build` and commit the result with your change.
