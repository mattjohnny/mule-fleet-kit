// Background-job telemetry and heartbeats.
//
// Carried over from the original suite — these tests were driving the real
// functions rather than a stub, so they survived the rewrite. The rest of that
// file did not: it asserted a stream mapping it defined itself, and drove a fake
// response object that could not see the status, abort or ordering bugs. Those
// concerns now live in express.test.js against real Express.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { pingHeartbeat, runTrackedJob } from "../dist/index.js";

let lines = [];
const real = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  lines = [];
  const push = (line) => lines.push(JSON.parse(line));
  console.log = push;
  console.warn = push;
  console.error = push;
  return () => {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  };
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
    // Record the options too. A mock that ignores `method` and `signal` cannot
    // catch a heartbeat that silently starts sending GET, or one that loses its
    // timeout — mutation testing found exactly that hole in the previous mock.
    globalThis.fetch = async (url, options) => {
      calls.push({ url, ...options });
      return { ok: true, status: 200 };
    };
    try {
      await runTrackedJob("nightly", async () => 1, { heartbeatUrl: "https://hb.test/abc" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hb.test/abc");
    assert.equal(calls[0].method, "POST", "a heartbeat is a POST, not a GET");
    assert.equal(calls[0].redirect, "manual", "a redirecting host must not report health");
    assert.ok(calls[0].signal, "the ping must carry a timeout");
  });

  // A job that ran and threw must not look alive.
  it("does NOT ping the heartbeat when the job fails", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    // Record the options too. A mock that ignores `method` and `signal` cannot
    // catch a heartbeat that silently starts sending GET, or one that loses its
    // timeout — mutation testing found exactly that hole in the previous mock.
    globalThis.fetch = async (url, options) => {
      calls.push({ url, ...options });
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
