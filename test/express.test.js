// Tests that drive a REAL Express app over a REAL socket.
//
// The previous suite drove a hand-rolled fake response whose `finish()` was
// called by hand. It could only ever confirm the mental model it was built from,
// and it passed while the code logged every 4xx as a 500, dropped aborted
// requests entirely, and documented the wrong output stream. Anything about
// middleware ordering, status codes, or stream behaviour belongs here, against
// the framework, not against a stub.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import net from "node:net";

import { installErrorTelemetry, installRequestTelemetry } from "../dist/index.js";

// --- harness -----------------------------------------------------------------

let server;
let port;
let healthy = true;

/**
 * Capture stdout/stderr for the duration of `run`, then return the JSON lines.
 *
 * The settle delay is load-bearing: `finish` fires after the client already has
 * its response, so reading the log straight after the request returns reads it
 * before it is written.
 */
async function record(run) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  // Patch console, NOT process.stdout.write. Replacing the stream method
  // swallowed node:test's own reporter output, which mangled the run counts and
  // the exit code — a harness that corrupts the thing measuring it. logEvent
  // reaches the streams through console, so this observes exactly as much.
  console.log = (line) => out.push(String(line));
  console.error = (line) => err.push(String(line));

  let result;
  try {
    result = await run();
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  const parse = (chunks) =>
    chunks
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));

  const stdout = parse(out);
  const stderr = parse(err);
  return { result, stdout, stderr, lines: [...stdout, ...stderr] };
}

/**
 * One plain HTTP request on a fresh, non-pooled socket.
 *
 * Deliberately not `fetch`: undici keeps connections alive and defers the
 * server-side `finish` until the body is drained, which made assertions depend
 * on connection reuse rather than on the code under test.
 */
function request(path, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    socket.on("connect", () => {
      const head = [`${method} ${path} HTTP/1.1`, "Host: test", "Connection: close"];
      for (const [key, value] of Object.entries(headers)) head.push(`${key}: ${value}`);
      if (body) head.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(head.join("\r\n") + "\r\n\r\n" + body);
    });
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const [head] = raw.split("\r\n\r\n");
      const status = Number(head.split(" ")[1]);
      const headerMap = {};
      for (const line of head.split("\r\n").slice(1)) {
        const at = line.indexOf(":");
        if (at > 0) headerMap[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({ status, headers: headerMap });
    });
  });
}

before(async () => {
  const app = express();
  installRequestTelemetry(app);
  app.use(express.json({ limit: "1kb" }));

  app.get("/ok", (_req, res) => res.json({ ok: true }));
  // /health must be able to FAIL on its own path. Testing the failure case on a
  // different path (`/health-broken`) never exercised the quiet list at all,
  // which mutation testing caught: making the quiet check unconditional left
  // the suite green while failing health checks vanished.
  app.get("/health", (_req, res) =>
    healthy ? res.json({ ok: true }) : res.status(503).json({ ok: false })
  );
  app.post("/echo", (_req, res) => res.json({ ok: true }));
  app.get("/slow-body", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "1000" });
    res.write("x".repeat(10));
    // deliberately never ends — the client aborts
  });
  app.get("/throw-403", () => {
    const error = new Error("nope");
    error.status = 403;
    throw error;
  });
  app.get("/throw-plain", () => {
    throw new TypeError("plain failure");
  });

  // Routes registered ABOVE this line are covered; that is the contract.
  installErrorTelemetry(app);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: "handled" });
  });

  server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  port = server.address().port;
});

after(() => server?.close());

// --- the bugs the fake response could not see --------------------------------

describe("status reporting", () => {
  it("logs a 403 as 403, not 500 — err.status is the source of truth", async () => {
    const { lines } = await record(() => request("/throw-403"));
    const error = lines.find((l) => l.event === "unhandled_error");
    assert.equal(error.status, 403, "a 4xx must not be reported as a server error");
    assert.equal(error.level, "warn", "a client error is not level:error");

    const http = lines.find((l) => l.event === "http_request");
    assert.equal(http.status, 403, "and the two lines must agree");
    assert.equal(http.request_id, error.request_id);
  });

  it("logs a body-parser 413 as 413", async () => {
    const { lines, result } = await record(() =>
      request("/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(4000) }),
      })
    );
    assert.equal(result.status, 413);
    assert.equal(lines.find((l) => l.event === "unhandled_error").status, 413);
  });

  it("still reports 500 for an error that names no status", async () => {
    const { lines } = await record(() => request("/throw-plain"));
    const error = lines.find((l) => l.event === "unhandled_error");
    assert.equal(error.status, 500);
    assert.equal(error.level, "error");
    assert.equal(error.error_name, "TypeError");
  });
});

describe("health-check noise", () => {
  it("does not log a successful /health", async () => {
    const { lines } = await record(() => request("/health"));
    assert.equal(lines.filter((l) => l.event === "http_request").length, 0);
  });

  it("DOES log a failing health check, on the same quiet path", async () => {
    healthy = false;
    try {
      const { lines } = await record(() => request("/health"));
      const line = lines.find((l) => l.event === "http_request");
      assert.ok(line, "a failing health check must not be silenced by the quiet list");
      assert.equal(line.status, 503);
      assert.equal(line.path, "/health");
    } finally {
      healthy = true;
    }
  });

  it("still logs other paths", async () => {
    const { lines } = await record(() => request("/ok"));
    assert.equal(lines.filter((l) => l.event === "http_request").length, 1);
  });
});

describe("aborted requests", () => {
  it("logs a line when the client disconnects mid-response", async () => {
    const { lines } = await record(async () => {
      const socket = net.connect(port, "127.0.0.1");
      await once(socket, "connect");
      socket.write("GET /slow-body HTTP/1.1\r\nHost: test\r\n\r\n");
      await once(socket, "data");
      socket.destroy();
    });
    const line = lines.find((l) => l.event === "http_request" && l.path === "/slow-body");
    assert.ok(line, "an aborted request must not vanish");
    assert.equal(line.aborted, true);
    assert.equal(line.level, "warn");
  });

  it("emits exactly one line per request, not one per event", async () => {
    const { lines } = await record(() => request("/ok"));
    assert.equal(lines.filter((l) => l.event === "http_request").length, 1);
  });
});

describe("request ids", () => {
  it("sets X-Request-ID and logs the same value", async () => {
    const { lines, result } = await record(() => request("/ok"));
    const header = result.headers["x-request-id"];
    assert.ok(header, "the header is set");
    const line = lines.find((l) => l.event === "http_request");
    assert.ok(line, "the request was logged");
    assert.equal(line.request_id, header);
  });

  it("honours an inbound id", async () => {
    const { result } = await record(() =>
      request("/ok", { headers: { "X-Request-ID": "trace-9" } })
    );
    assert.equal(result.headers["x-request-id"], "trace-9");
  });
});
