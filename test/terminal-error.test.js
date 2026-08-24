// What a caller is told when a request fails — over a real socket, because the
// interesting cases are all about bytes that did or did not leave the process.
//
// Every assertion here is negative in the same way: the thrown message, the
// stack, and the request payload must be ABSENT. A test that only checked the
// house sentence was present would pass while the leak sat next to it, which is
// how the per-app copies of this handler shipped `error.message` to browsers for
// two years.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";
import { once } from "node:events";
import net from "node:net";

import {
  installErrorTelemetry,
  installRequestTelemetry,
  installTerminalErrorHandler,
} from "../dist/index.js";

// --- the values that must never come back ------------------------------------

// A message no house sentence, header or framing string could contain by
// accident, so "absent" means absent rather than "did not collide".
const THROWN = "wage-row mj@otherbird.com 31.50 token sk-live-9f3a2b";
const PAYLOAD_MARKER = "staff_wage_payload_marker";
const PARTIAL_BODY = "partial-export-row-marker";

const HOUSE_500 = "Something went wrong on our side — it's been logged.";
const HOUSE_4XX = "That request couldn't be read.";
const HOUSE_413 = "That upload is too large.";

// --- harness -----------------------------------------------------------------

let port;
let controlPort;
let server;
let controlServer;

/**
 * Capture stdout/stderr for the duration of `run`.
 *
 * Same shape as test/express.test.js, with the RAW lines kept as well as the
 * parsed ones. The raw ones are load-bearing here: the failure this suite is
 * most afraid of — Express's default handler getting the error and printing a
 * stack — produces a non-JSON line on stderr and nothing else observable.
 *
 * The settle delay is equally load-bearing: Express defers its default
 * handler's `onerror` with setImmediate, so reading stderr the moment the
 * client's socket closes reads it before that stack is printed.
 */
async function record(run) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
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

  const split = (chunks) => chunks.flatMap((chunk) => chunk.split("\n"));
  const rawOut = split(out);
  const rawErr = split(err);
  const lines = [...rawOut, ...rawErr]
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return { result, lines, rawOut, rawErr };
}

/**
 * One plain HTTP request on a fresh, non-pooled socket, returning the BODY too.
 *
 * Not `fetch`: a destroyed connection is a normal outcome in this file, and
 * undici turns that into a rejected promise several layers away from the bytes.
 * Here a reset socket is data — `socketError` — not a test failure. Chunks are
 * concatenated as Buffers before decoding so a multi-byte character (the em dash
 * in the 500 sentence) cannot be split across two reads.
 */
function request(targetPort, path, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(targetPort, "127.0.0.1");
    const chunks = [];
    let socketError;
    socket.on("connect", () => {
      const head = [`${method} ${path} HTTP/1.1`, "Host: test", "Connection: close"];
      for (const [key, value] of Object.entries(headers)) head.push(`${key}: ${value}`);
      if (body) head.push(`Content-Length: ${Buffer.byteLength(body)}`);
      socket.write(head.join("\r\n") + "\r\n\r\n" + body);
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      socketError = error;
    });
    socket.on("close", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const at = raw.indexOf("\r\n\r\n");
      const head = at === -1 ? raw : raw.slice(0, at);
      const headerMap = {};
      for (const line of head.split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headerMap[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({
        status: Number(head.split(" ")[1]),
        headers: headerMap,
        body: at === -1 ? "" : raw.slice(at + 4),
        raw,
        socketError,
      });
    });
  });
}

/** No stack frame, no error class, no thrown message — anywhere in these bytes. */
function assertNoDiagnostics(text, context) {
  assert.ok(!text.includes(THROWN), `${context}: the thrown message leaked`);
  assert.ok(!text.includes("    at "), `${context}: a stack frame leaked`);
  assert.ok(!text.includes("terminal-error"), `${context}: a source path leaked`);
  assert.ok(!text.includes("Error:"), `${context}: an error class leaked`);
}

before(async () => {
  const app = express();
  installRequestTelemetry(app);
  app.use(express.json({ limit: "1kb" }));

  app.get("/ok", (_req, res) => res.json({ ok: true }));
  app.post("/echo", (_req, res) => res.json({ ok: true }));
  app.get("/throw-plain", () => {
    throw new Error(THROWN);
  });
  app.get("/throw-403", () => {
    const error = new Error(THROWN);
    error.status = 403;
    throw error;
  });
  // A streamed export that fails halfway through its rows: the status line left
  // the process long ago, so there is nothing left to answer with. The failure
  // is deferred until the first rows have actually reached the client, because
  // `res.destroy()` discards whatever is still in the socket's write queue —
  // failing in the same tick as the write tests a response that never left,
  // which is not the case this brick exists for.
  app.get("/stream-then-fail", (_req, res, next) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write(PARTIAL_BODY, () => {
      setTimeout(() => next(new Error(THROWN)), 25);
    });
  });
  app.get("/app-handles-it", () => {
    const error = new Error(THROWN);
    error.handledLocally = true;
    throw error;
  });

  installErrorTelemetry(app);
  // The app's own handler, registered BEFORE the terminal one — the whole point
  // of installing last is that this still wins.
  app.use((error, _req, res, next) => {
    if (!error?.handledLocally) return next(error);
    res.status(418).json({ error: "the app answered this one" });
  });
  installTerminalErrorHandler(app);

  // The control: a bare Express app with none of this installed. Without it the
  // x-powered-by assertions below would pass just as happily against a framework
  // that never sent the header in the first place.
  const control = express();
  control.get("/ok", (_req, res) => res.json({ ok: true }));

  server = app.listen(0, "127.0.0.1");
  controlServer = control.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(controlServer, "listening")]);
  port = server.address().port;
  controlPort = controlServer.address().port;
});

after(() => {
  server?.close();
  controlServer?.close();
});

// --- the answer --------------------------------------------------------------

describe("the house answer", () => {
  it("answers a thrown error with 500 and the house sentence, and nothing else", async () => {
    const { result } = await record(() => request(port, "/throw-plain"));

    assert.equal(result.status, 500);
    assert.match(result.headers["content-type"], /^application\/json/);
    assert.equal(result.body, JSON.stringify({ error: HOUSE_500 }));
    assertNoDiagnostics(result.raw, "500 response");
  });

  it("honours err.status: a 403 is answered 403, with the client sentence", async () => {
    const { result } = await record(() => request(port, "/throw-403"));

    assert.equal(result.status, 403);
    assert.equal(result.body, JSON.stringify({ error: HOUSE_4XX }));
    assertNoDiagnostics(result.raw, "403 response");
  });

  it("does not explain a malformed body back to the sender", async () => {
    // body-parser's SyntaxError quotes the offending payload in its message, so
    // this is the case where "it is only a 4xx, we can afford to be helpful"
    // becomes a leak of whatever the caller was posting.
    const { result } = await record(() =>
      request(port, "/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"${PAYLOAD_MARKER}": `,
      })
    );

    assert.equal(result.status, 400);
    assert.equal(result.body, JSON.stringify({ error: HOUSE_4XX }));
    assert.ok(!result.raw.includes(PAYLOAD_MARKER), "the payload came back to the sender");
    assertNoDiagnostics(result.raw, "400 response");
  });

  it("tells an oversized upload what is actually wrong with it", async () => {
    const { result } = await record(() =>
      request(port, "/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(4000) }),
      })
    );

    assert.equal(result.status, 413);
    assert.equal(result.body, JSON.stringify({ error: HOUSE_413 }));
  });
});

// --- the response that cannot be answered ------------------------------------

describe("an error after the response has started", () => {
  it("destroys the connection instead of handing Express the error", async () => {
    const { result, rawErr } = await record(() => request(port, "/stream-then-fail"));

    assert.ok(result.raw.startsWith("HTTP/1.1 200"), "the head had already gone out");
    assert.ok(
      !result.raw.endsWith("0\r\n\r\n"),
      "a destroyed response must not terminate cleanly — the client has to know it is truncated"
    );
    assert.ok(!result.raw.includes(HOUSE_500), "a second status/body cannot be sent");
    assertNoDiagnostics(result.raw, "truncated response");

    // The mutation this guards: drop the headers-sent branch and res.json()
    // throws ERR_HTTP_HEADERS_SENT, Express's default handler takes the error,
    // and prints an unstructured stack to stderr. Every line this package writes
    // is JSON; a line that is not JSON means something else got hold of it.
    for (const line of rawErr) {
      if (line.trim() === "") continue;
      assert.ok(
        line.startsWith("{"),
        `something printed to stderr outside this package's format: ${line}`
      );
    }
  });
});

// --- the framework fingerprint -----------------------------------------------

describe("x-powered-by", () => {
  it("is gone from successful and failed responses alike", async () => {
    const { result: ok } = await record(() => request(port, "/ok"));
    const { result: failed } = await record(() => request(port, "/throw-plain"));

    assert.equal(ok.status, 200);
    assert.equal(ok.headers["x-powered-by"], undefined);
    assert.equal(failed.status, 500);
    assert.equal(failed.headers["x-powered-by"], undefined);
  });

  it("is present on a bare Express app — the header is real, and we removed it", async () => {
    const { result } = await record(() => request(controlPort, "/ok"));

    assert.equal(result.status, 200);
    assert.equal(
      result.headers["x-powered-by"],
      "Express",
      "if this ever fails, the assertions above prove nothing"
    );
  });
});

// --- composition -------------------------------------------------------------

describe("composed with installErrorTelemetry", () => {
  it("still logs unhandled_error, and the caller still gets the house JSON", async () => {
    const { result, lines } = await record(() => request(port, "/throw-plain"));

    const logged = lines.find((line) => line.event === "unhandled_error");
    assert.ok(logged, "answering the caller must not swallow the telemetry line");
    assert.equal(logged.error_name, "Error");
    assert.equal(result.status, 500);
    assert.deepEqual(JSON.parse(result.body), { error: HOUSE_500 });
  });

  it("answers the status it logs — one derivation, not two", async () => {
    // The two handlers derive the status from the same function on purpose. If
    // they ever drift, the log source says 403 while the caller was told 500,
    // and the alerting built on `unhandled_error` describes a different incident
    // from the one the caller experienced.
    const { result, lines } = await record(() => request(port, "/throw-403"));
    const logged = lines.find((line) => line.event === "unhandled_error");

    assert.equal(logged.status, 403);
    assert.equal(result.status, logged.status);

    const { result: overLimit, lines: overLimitLines } = await record(() =>
      request(port, "/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pad: "x".repeat(4000) }),
      })
    );
    const loggedOverLimit = overLimitLines.find((line) => line.event === "unhandled_error");
    assert.equal(loggedOverLimit.status, 413);
    assert.equal(overLimit.status, loggedOverLimit.status);
  });

  it("never runs when the app's own handler already answered", async () => {
    const { result } = await record(() => request(port, "/app-handles-it"));

    assert.equal(result.status, 418);
    assert.deepEqual(JSON.parse(result.body), { error: "the app answered this one" });
    assert.ok(!result.raw.includes(HOUSE_500), "the terminal handler overrode the app");
  });
});
