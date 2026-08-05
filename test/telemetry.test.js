import assert from "node:assert/strict";
import { after, beforeEach, describe, it, mock } from "node:test";

import {
  errorFields,
  errorSite,
  installErrorTelemetry,
  installRequestTelemetry,
  logEvent,
  pingHeartbeat,
  runTrackedJob,
  safeErrorName,
} from "../dist/index.js";

// --- capture -----------------------------------------------------------------

let lines = [];
const real = { log: console.log, warn: console.warn, error: console.error };

function capture() {
  lines = [];
  const push = (line) => lines.push(JSON.parse(line));
  console.log = push;
  console.warn = push;
  console.error = push;
}

function restore() {
  console.log = real.log;
  console.warn = real.warn;
  console.error = real.error;
}

beforeEach(() => capture());
after(() => restore());

/** Collect the middleware an app.use() call registers. */
function fakeApp() {
  const middleware = [];
  return { use: (fn) => middleware.push(fn), middleware };
}

function fakeReq({ method = "GET", path = "/x", headers = {} } = {}) {
  return { method, path, get: (name) => headers[name.toLowerCase()] };
}

function fakeRes({ statusCode = 200 } = {}) {
  const handlers = {};
  return {
    statusCode,
    headersSent: false,
    locals: {},
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    once(event, fn) {
      handlers[event] = fn;
    },
    finish() {
      handlers.finish?.();
    },
  };
}

// --- logEvent ----------------------------------------------------------------

describe("logEvent", () => {
  it("emits one parseable JSON object carrying level, event and build", () => {
    logEvent("info", "thing_happened", { count: 2 });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].event, "thing_happened");
    assert.equal(lines[0].count, 2);
    assert.ok(lines[0].timestamp);
    assert.ok(lines[0].build);
  });

  it("routes error to stderr and warn to stdout, so the level is never inferred", () => {
    const streams = [];
    console.error = () => streams.push("stderr");
    console.warn = () => streams.push("stdout");
    console.log = () => streams.push("stdout");
    logEvent("error", "a");
    logEvent("warn", "b");
    logEvent("info", "c");
    assert.deepEqual(streams, ["stderr", "stdout", "stdout"]);
  });
});

// --- request telemetry -------------------------------------------------------

describe("installRequestTelemetry", () => {
  it("sets X-Request-ID, exposes it on locals, and logs it on finish", () => {
    const app = fakeApp();
    installRequestTelemetry(app);
    const res = fakeRes();
    app.middleware[0](fakeReq(), res, () => {});

    const id = res.headers["X-Request-ID"];
    assert.ok(id, "header is set before the route runs");
    assert.equal(res.locals.requestId, id);

    res.finish();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "http_request");
    assert.equal(lines[0].request_id, id);
  });

  it("honours an inbound X-Request-ID so a call chain shares one id", () => {
    const app = fakeApp();
    installRequestTelemetry(app);
    const res = fakeRes();
    app.middleware[0](fakeReq({ headers: { "x-request-id": "upstream-1" } }), res, () => {});
    assert.equal(res.headers["X-Request-ID"], "upstream-1");
  });

  it("caps a hostile inbound id rather than echoing it whole", () => {
    const app = fakeApp();
    installRequestTelemetry(app);
    const res = fakeRes();
    app.middleware[0](fakeReq({ headers: { "x-request-id": "z".repeat(5000) } }), res, () => {});
    assert.ok(res.headers["X-Request-ID"].length <= 200);
  });

  it("warns on a 5xx and stays info on a 200", () => {
    const app = fakeApp();
    installRequestTelemetry(app);
    for (const statusCode of [200, 500]) {
      const res = fakeRes({ statusCode });
      app.middleware[0](fakeReq(), res, () => {});
      res.finish();
    }
    assert.equal(lines[0].level, "info");
    assert.equal(lines[1].level, "warn");
  });

  it("calls next so the request still reaches its route", () => {
    const app = fakeApp();
    installRequestTelemetry(app);
    const next = mock.fn();
    app.middleware[0](fakeReq(), fakeRes(), next);
    assert.equal(next.mock.callCount(), 1);
  });

  // The hygiene guard. req.path excludes the query string; req.originalUrl does
  // not, and this fleet puts e-mail addresses in ?email=.
  it("never lets a query string into the log line", () => {
    const app = fakeApp();
    installRequestTelemetry(app);
    const res = fakeRes();
    const req = fakeReq({ path: "/api/context" });
    req.originalUrl = "/api/context?email=someone@otherbird.com";
    app.middleware[0](req, res, () => {});
    res.finish();

    const emitted = JSON.stringify(lines[0]);
    assert.equal(lines[0].path, "/api/context");
    assert.ok(!emitted.includes("email"), "no query string reached the log");
    assert.ok(!emitted.includes("otherbird.com"));
  });
});

// --- error hygiene -----------------------------------------------------------

describe("safeErrorName", () => {
  it("passes an allow-listed name through", () => {
    assert.equal(safeErrorName(new TypeError("x")), "TypeError");
  });

  it("collapses an unrecognized name to Error", () => {
    const error = new Error("x");
    error.name = "SecretsManagerAccessDenied";
    assert.equal(safeErrorName(error), "Error");
  });

  it("handles non-errors without throwing", () => {
    assert.equal(safeErrorName(undefined), "Error");
    assert.equal(safeErrorName("a string"), "Error");
    assert.equal(safeErrorName(null), "Error");
  });
});

describe("errorSite", () => {
  it("reports file:line for the app's own frame", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at Database.get (/app/node_modules/better-sqlite3/lib/db.js:12:9)",
      "    at loadShift (/opt/render/project/src/src/db.ts:412:18)",
    ].join("\n");
    assert.equal(errorSite(error), "src/db.ts:412");
  });

  it("skips node: internal frames", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "    at sync (/opt/render/project/src/src/worker.ts:7:1)",
    ].join("\n");
    assert.equal(errorSite(error), "src/worker.ts:7");
  });

  it("returns undefined rather than guessing when there is no stack", () => {
    assert.equal(errorSite({}), undefined);
    assert.equal(errorSite("nope"), undefined);
  });
});

// The reason this package exists in one place instead of fourteen.
describe("error message hygiene", () => {
  it("keeps a secret-bearing message out of the emitted fields", () => {
    const error = new Error(
      "AccessDenied: arn:aws:secretsmanager:us-east-1:12345:secret:mule/prod/toast-Ab3xY"
    );
    const emitted = JSON.stringify(errorFields(error));
    assert.ok(!emitted.includes("arn:aws"));
    assert.ok(!emitted.includes("Ab3xY"));
    assert.ok(!emitted.includes("AccessDenied"));
    assert.equal(JSON.parse(emitted).error_name, "Error");
  });

  it("keeps a session token out of an unhandled_error line", () => {
    const app = fakeApp();
    installErrorTelemetry(app);
    const error = new Error("GET https://portal/api/context?token=sk-live-9f3a2b failed");
    app.middleware[0](error, fakeReq(), fakeRes(), () => {});
    const emitted = JSON.stringify(lines[0]);
    assert.ok(!emitted.includes("sk-live-9f3a2b"));
    assert.ok(!emitted.includes("token="));
  });
});

describe("installErrorTelemetry", () => {
  it("logs at error level and passes the error on untouched", () => {
    const app = fakeApp();
    installErrorTelemetry(app);
    const error = new TypeError("bad");
    const next = mock.fn();
    app.middleware[0](error, fakeReq({ method: "POST", path: "/save" }), fakeRes(), next);

    assert.equal(lines[0].level, "error");
    assert.equal(lines[0].event, "unhandled_error");
    assert.equal(lines[0].method, "POST");
    assert.equal(lines[0].path, "/save");
    assert.equal(lines[0].error_name, "TypeError");
    assert.equal(next.mock.callCount(), 1);
    assert.equal(next.mock.calls[0].arguments[0], error, "the same error, not a copy");
  });

  it("records the request id so an error joins its http_request line", () => {
    const app = fakeApp();
    installRequestTelemetry(app);
    installErrorTelemetry(app);
    const res = fakeRes();
    app.middleware[0](fakeReq(), res, () => {});
    app.middleware[1](new Error("x"), fakeReq(), res, () => {});
    assert.equal(lines[0].request_id, res.locals.requestId);
  });
});

// --- jobs --------------------------------------------------------------------

describe("runTrackedJob", () => {
  it("logs start and finish with a duration, and returns the value", async () => {
    const result = await runTrackedJob("nightly", async () => 42);
    assert.equal(result, 42);
    assert.deepEqual(
      lines.map((l) => l.event),
      ["job_started", "job_finished"]
    );
    assert.equal(typeof lines[1].duration_ms, "number");
    assert.equal(lines[1].job, "nightly");
  });

  it("logs job_failed at error level and re-throws", async () => {
    await assert.rejects(
      runTrackedJob("nightly", async () => {
        throw new RangeError("nope");
      }),
      RangeError
    );
    assert.equal(lines[1].event, "job_failed");
    assert.equal(lines[1].level, "error");
    assert.equal(lines[1].error_name, "RangeError");
  });

  it("pings the heartbeat on success", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    };
    try {
      await runTrackedJob("nightly", async () => 1, { heartbeatUrl: "https://hb.test/abc" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(calls, ["https://hb.test/abc"]);
  });

  // A job that ran and threw must not look alive.
  it("does NOT ping the heartbeat when the job fails", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    };
    try {
      await assert.rejects(
        runTrackedJob("nightly", async () => {
          throw new Error("nope");
        }, { heartbeatUrl: "https://hb.test/abc" })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(calls, [], "a failed run leaves the heartbeat to expire");
  });
});

describe("pingHeartbeat", () => {
  it("does nothing without a url, so an unconfigured app still runs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail("should not be called");
    try {
      await pingHeartbeat(undefined, "nightly");
      await pingHeartbeat("", "nightly");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(lines.length, 0);
  });

  it("never throws when the ping fails, and never logs the url", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    try {
      await pingHeartbeat("https://hb.test/secret-token-xyz", "nightly");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(lines[0].event, "heartbeat_ping_failed");
    assert.equal(lines[0].level, "warn");
    assert.ok(!JSON.stringify(lines[0]).includes("secret-token-xyz"));
  });

  it("warns on a non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    try {
      await pingHeartbeat("https://hb.test/abc", "nightly");
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(lines[0].event, "heartbeat_ping_failed");
    assert.equal(lines[0].status, 503);
  });
});
