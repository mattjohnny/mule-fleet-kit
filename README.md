# @mule/fleet-kit

Shared infrastructure for The Mule's app fleet: Render caller attribution,
structured logging, error telemetry, the terminal error handler, and
background-job heartbeats.

Built for [`mule-fleet-docs`](https://github.com/mattjohnny/mule-fleet-docs) job 3.
The alerting side of that job (Better Stack log source, `/health` monitors, the
`app_error_5xx` alert) is already live and needs no app code; this package is the
in-app half.

## Install

```bash
npm install github:mattjohnny/mule-fleet-kit#v0.4.0
```

**Do not use `v0.1.0.`** Review found a quadratic regex reachable from any route
that puts request text in an error message (12.8 seconds of blocked event loop
from one request), error messages reaching the log through multi-line stacks,
every 4xx logged as a 500, and `logEvent` able to throw from inside a `finish`
listener. All fixed in `v0.2.0`; the details are in the source comments, because
the reasoning matters more than the diff.

Pin the tag, the way apps pin `@mule/portal-auth`. Never track `main` — a shared
dependency that moves on its own turns one bad commit into fourteen incidents.

## Render caller attribution

Every Render-hosted Mule app installs caller attribution once, before registering
an IP-keyed limiter:

```ts
import { installRenderCallerAttribution } from "@mule/fleet-kit";

const callerKey = installRenderCallerAttribution(app, {
  probeKey: process.env.RATE_LIMIT_PROBE_KEY,
});
```

That call installs the fleet's verified Render proxy trust and returns the one
normalized caller-key function used by both limiter shapes:

```ts
// Fleet-style custom limiter
const key = callerKey(req);

// Direct express-rate-limit use
app.use("/sign-in", rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  keyGenerator: callerKey,
}));
```

Apps still own routes, windows, thresholds, stores, responses, and non-IP abuse
controls. Do not add another `app.set("trust proxy", <hop count>)`: the installer
refuses a conflicting configuration instead of overwriting it. A request with no
usable address shares the stable `unknown` bucket, so it remains serviceable but
does not bypass accounting.

Each service has its own retained probe credential. Store it only in Render and
declare it as externally managed in `render.yaml`:

```yaml
envVars:
  - key: RATE_LIMIT_PROBE_KEY
    sync: false
```

Pass the value to the installer as shown above; never put it in source, docs,
logs, chat, or a shared fleet secret. A missing or exactly empty (`""`) credential
leaves attribution active and emits one `caller_attribution_probe_disabled`
warning, but the app remains unverified until configuration is corrected.
Nonempty credentials with fewer than 32 characters after trimming, including
whitespace-only values, still fail startup.

An authorized request carrying `x-rate-limit-probe` causes the installed
middleware to emit `caller_attribution_probe`, including in an app that does not
yet use the returned key. The event contains only per-process opaque references
and a bounded hop count—never raw caller addresses or the credential. Missing or
incorrect authorization emits no probe telemetry.

### New-app adoption contract

Before a new Render-hosted app reaches production:

1. Install caller attribution once, even if the app has no IP limiter yet.
2. Maintain an app-owned request-control map, linked from its `AGENTS.md`, that
   classifies every externally reachable route group as IP-limited, protected by
   another abuse control, or intentionally exempt with a rationale.
3. Prove through the app's request boundary that every declared IP limiter uses
   `callerKey`, and keep a ratchet rejecting app-local proxy-hop literals.
4. Provision the unique externally managed probe credential before an
   auto-deploying merge.

This is an attribution contract, not a fleet-wide rate-limit policy.

## Wiring an app

Five calls. **Order matters for three of them**, because Express runs middleware
in registration order.

```ts
import {
  installProcessErrorHandlers,
  installRequestTelemetry,
  installErrorTelemetry,
  installTerminalErrorHandler,
  startRuntimeTelemetry,
} from "@mule/fleet-kit";

installProcessErrorHandlers();   // once, as early as possible
startRuntimeTelemetry();         // once, any time after

const app = express();
installRequestTelemetry(app);    // BEFORE the routes

// ... routes ...

installErrorTelemetry(app);      // AFTER the routes, BEFORE any error handler

// ... your own error handlers, if you have any ...

installTerminalErrorHandler(app); // LAST — it answers the caller
```

`installRequestTelemetry` after the routes sees nothing — a response that finishes
in an earlier handler never reaches a later one. `installErrorTelemetry` after
your own error handler also sees nothing, for the same reason: whichever handler
sends the response ends the chain.

### The terminal error handler

`installTerminalErrorHandler(app)` is the last middleware an app registers, and
it replaced seven per-app copies that had drifted apart. It answers a failed
request with one of three fixed sentences and **nothing else**:

| status | body |
| --- | --- |
| 413 | `{"error":"That upload is too large."}` |
| other 4xx | `{"error":"That request couldn't be read."}` |
| 5xx | `{"error":"Something went wrong on our side — it's been logged."}` |

The status is the same one `installErrorTelemetry` logged, from the same
function — so the line in the log source and the answer the caller received can
never describe different incidents.

**It never logs.** `installErrorTelemetry` logged this error one middleware ago,
hygienically; a second line here could only add the part that must not be
emitted.

**It never emits `error.message` or `error.stack` — not even for a 4xx.** A 4xx
feels safe to explain, and that is the trap: `express.json()` rejects a malformed
body with a message quoting the payload, so being helpful reflects the caller's
own data — staff names and wages, in this fleet — back out in the response.

**If the response has already started, it destroys the connection.** There is no
status line left to change, `res.json()` there throws `ERR_HTTP_HEADERS_SENT`,
and handing the error on to Express's default handler makes it print a raw stack
to stderr, straight past everything this package guarantees. A truncated response
is the honest answer: the client can tell the body is incomplete, because it is.

**It also disables `x-powered-by`**, the header advertising the framework to
anyone scanning the fleet for a version with a known advisory. It lives here
because this is the call every app is adding anyway
([`mule-fleet-docs`](https://github.com/mattjohnny/mule-fleet-docs) job 26,
cluster 4) rather than a fourteenth line to add to fourteen bootstraps.

An app that wants to keep its own terminal handler simply does not call this;
everything above it in the order is unaffected.

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

> ⚠ **The job must actually reject when it fails.** This is the sharpest edge
> here and it drew blood on first use: `mule-workback`'s backup already caught
> its own failures internally and resolved anyway, so wrapping it produced
> `job_finished` and a **green heartbeat for backups that never happened** — a
> monitoring system reporting health for the exact failure it was installed to
> catch. Read the function before wrapping it. If it swallows, make it re-throw
> or return a result the caller checks. If you can't, pass no `heartbeatUrl`: the
> log lines are still worth having, and an absent heartbeat is honest where a
> green one is not.

Create the heartbeat in Better Stack, set its period to the job's schedule plus
slack, and put its URL in the app's environment. **Leave it paused until the ping
is deployed** — an unpaused heartbeat with nothing pinging it raises an incident
as soon as its period elapses.

## Events

| event | level | when |
| --- | --- | --- |
| `http_request` | info, `warn` at ≥1s / 5xx / aborted | every response that finishes **or** is aborted |
| `node_runtime` | info, `warn` on a ≥500ms stall | every 60s |
| `unhandled_error` | `error` at 5xx, `warn` at 4xx | anything reaching Express's error path |
| `unhandled_rejection` | error | a promise rejection nobody caught |
| `uncaught_exception` | error | a throw nobody caught |
| `job_started` / `job_finished` | info | `runTrackedJob` |
| `job_failed` | error | `runTrackedJob`, then re-thrown |
| `heartbeat_ping_failed` | warn | the ping failed; the heartbeat itself is the alert |

Every line carries `timestamp`, `level`, `event`, `build`, `service_id` and
`instance_id`, and a caller field cannot overwrite any of them — a colliding key
is prefixed `field_` so a line can never contradict the stream it was written to.
Request-scoped lines carry `request_id`; use `requestId(res)` to put it on your
own lines so they join up.

**Streams:** `info` on stdout, `warn` and `error` on stderr — Node's
`console.warn` is an alias for `console.error`. Verified from a child process
reading real file descriptors, because the previous in-process test asserted a
mapping it had defined itself, and the mapping was wrong.

**Successful `/health` responses are not logged.** They were 98.3% of one app's
volume — 14,701 lines in 24 hours against 206 for `/api/*` — on a platform that
bills by volume. A *failing* health check is always logged. Override with
`installRequestTelemetry(app, { ignoreSuccessfulPaths: [...] })`.

**Aborted requests are logged** with `aborted: true`. Listening only for `finish`
meant a client disconnecting mid-response produced no line at all, which hid
exactly the failures most likely to be invisible: client timeouts, Cloudflare
524s, load-balancer drops.

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

**Secret-looking path segments are redacted to `:id`** — added after review found
`mule-quarterly` writing its `/reports/<64-hex HMAC>` capability tokens straight
into the log source. This is **best-effort by shape, not a guarantee.** It
catches what the fleet actually emits — hex strings of 16+ chars, UUIDs, and long
mixed-case-and-digit tokens — and deliberately leaves ordinary slugs, dates and
short ids readable. It will **miss** an all-lowercase-and-digit token or a
base64 token with `+`/`/`, because widening it far enough to catch those would
start eating legitimate readable paths (a cost the "leaves readable paths alone"
mutation guards against). If you add a route that puts an opaque token in the
path, do not rely on this — keep the token out of the path, or add its shape to
`looksLikeSecret`.

All three are covered by tests that assert the sensitive value is absent from the
emitted JSON, each backed by a mutation, so a regression fails CI rather than
quietly shipping.

## Crash semantics

`installProcessErrorHandlers` does **not** make a crashing app survive. An app
that continues after an uncaught exception is running on state it cannot vouch
for, and Render restarting it is the right outcome — so it logs, re-emits the
original error, and exits non-zero immediately, which is what Node would have
done anyway.

Three details, each of which was wrong in `v0.1.0`:

**It re-emits the original error.** Registering a handler for these signals
suppresses Node's own stack dump, so v0.1.0 silently traded a full
`Error: SQLITE_CANTOPEN: unable to open database file /data/app.db` plus stack
for a line reading `error_name: "Error"` — and when every frame is inside a
dependency there is no `error_site` either, leaving nothing to debug a failed
deploy with. Printing it is not a new leak: Node prints that exact text today.
The no-messages rule governs the structured lines, which are queried and shared;
a fatal crash dump is read once, by whoever is fixing the outage.

**Ownership is decided at crash time, not install time.** This README says
install early, so your own handler is normally registered *later* — reading the
listener count during install never saw it, and v0.1.0 hard-exited straight
through a graceful shutdown that had only just begun.

**It exits immediately.** v0.1.0 waited 100ms "to flush", which bought nothing
(stdio writes to a pipe are synchronous on Linux and Windows) and let the process
keep accepting requests on state it had just declared untrustworthy.

**Ownership asks *who*, not *how many* — fixed in `v0.2.2`.** Up to `v0.2.1` the
crash-time test was `process.listenerCount(signal) > 1`, which cannot tell "the
app will exit the process" from "the app also decided to defer". Installing twice
— two entry points in one process, or npm resolving the package at two paths —
gave two of *our* handlers, each of which read the other as an owner: both logged
`fatal: false`, **nobody exited**, and the app kept serving. Any third-party
log-only listener did the same. Now each listener we register carries a marker,
and a foreign owner exists only when some registered listener lacks it, so:

- sole listener → `fatal: true`, re-emit, exit 1 (unchanged);
- two fleet-kit copies → kin, so whichever runs first still exits;
- the app's own handler → `fatal: false`, no exit (unchanged) — a graceful
  shutdown is still never hard-exited through.

`installProcessErrorHandlers()` is also idempotent now: a second call is a no-op.
`test/fatal.test.js` covers all of it from child processes, because an exit code
is a fact about a real process.

## Development

```bash
npm ci
npm run verify    # typecheck + tests + mutation testing
```

`npm run mutation` breaks the implementation on purpose — 46 deliberate defects,
each one drawn from a real review finding — and **requires the suite to catch
every one**. This is the gate that matters. `v0.1.0` shipped 25 green tests that
12 of 18 breakages walked straight through, including "always log status 500" and
"read the error message as well as the stack". A suite that has never been
mutation-tested is not evidence; the fleet's
[verification bar](https://github.com/mattjohnny/mule-fleet-docs/blob/main/standards.md)
now says so in writing.

If you add behaviour, add a mutation for it. If a mutation survives, the suite
has a hole at exactly that point — that is the finding, not a nuisance.

The gate counts a kill only after a successful build and a completed test run
with an assertion failure inside a test body. Compiler errors, load or setup
failures, raw exceptions, cancellation, signals, and timeouts are invalid runs;
they fail the gate and do not count as kills. The runner retains full command
output, structured test events, applied source diffs, and restoration hashes in
a fresh temporary directory, whose path it prints. Set `MULE_MUTATION_PROOF_DIR`
to an empty directory to retain evidence at a chosen location. Diagnostics also
appear in the CI log. Sources are restored after each case and rebuilt at exit.

The September 7, 2026 run at `f6e8d3e` that reported 46/46 kills is withdrawn:
its old runner accepted two compile failures and one raw rejection. Another
43 outputs contained assertions, including a later-identified mixed assertion
and raw-error case; these are not 43 accepted clean assertion kills. The two
invalid catalog entries now
produce runtime defects; the existing no-throw and no-reject behavioral tests
use explicit assertions. These proof corrections do not change production code.

Tests run against **real Express over a real socket**, not a stub. The original
suite drove a hand-rolled fake response and could only confirm the mental model
it was built from; every bug it missed was a place where Node and that model
disagreed.

`dist/` is committed — consumers install the repo as-is. CI fails if it drifts
from `src/`. Run `npm run build` and commit the result with your change.
