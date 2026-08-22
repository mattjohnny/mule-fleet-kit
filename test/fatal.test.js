// Crash ownership: who exits the process, and who only logs.
//
// This is the only code in the package that can kill a process, and until this
// file it had NO tests at all — the suite's single mention of uncaughtException
// was a comment. The defect that prompted it: ownership was decided by
// `process.listenerCount(signal) > 1`, which cannot distinguish "somebody else
// will exit" from "somebody else also deferred". Two installs (two entry points,
// or the package resolved at two paths) therefore produced two handlers that
// each saw the other, both logged `fatal: false`, and NOBODY exited — the app
// kept serving on state it had just declared untrustworthy.
//
// Every case runs in a CHILD PROCESS, for the same reason streams.test.js does:
// exit codes and stream contents are facts about a real process, and a test that
// stubs process.exit is asserting its own mental model. Here that model is the
// thing under test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
// A bare Windows path is not a legal ESM specifier — it needs a file:// URL.
const distUrl = JSON.stringify(pathToFileURL(path.join(dist, "index.js")).href);

/**
 * A SECOND COPY of the built package, at a different path.
 *
 * Not a contrivance: npm resolves a shared dependency twice whenever two
 * consumers pin different ranges, and each copy is a separate module instance
 * with its own closures and its own module-level state. The idempotence guard
 * cannot see across that boundary — only the marker on the listener can — so
 * this is the one case that exercises kin-awareness on its own. Copying the
 * build is what makes it a real second instance rather than a hand-made
 * imitation of one.
 */
function secondCopyUrl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-kit-copy-"));
  fs.cpSync(dist, path.join(dir, "dist"), { recursive: true });
  return JSON.stringify(pathToFileURL(path.join(dir, "dist", "index.js")).href);
}

/** Run a module source in a child, and report what the OS saw. */
function crash(source) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { installProcessErrorHandlers } from ${distUrl};\n${source}`],
    { encoding: "utf8" }
  );
  const structured = child.stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    structured,
    lines: (event) => structured.filter((line) => line.event === event),
  };
}

// A throw scheduled on the event loop, rather than at module top level: a
// top-level throw in an ESM entry point is reported by the loader, not through
// `uncaughtException`, so it would not exercise the handler at all.
const THROW_LATER = `setTimeout(() => { throw new Error("boom-uncaught"); }, 0);`;
const REJECT_LATER = `setTimeout(() => { Promise.reject(new Error("boom-rejection")); }, 0);
  setTimeout(() => {}, 2000);`;

describe("uncaughtException, sole fleet-kit listener", () => {
  const result = crash(`installProcessErrorHandlers();\n${THROW_LATER}`);

  it("exits 1 — the app does not survive a crash", () => {
    assert.equal(result.status, 1, result.stderr);
  });

  it("logs one structured uncaught_exception line marked fatal", () => {
    const lines = result.lines("uncaught_exception");
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].fatal, true);
    assert.equal(lines[0].level, "error");
    assert.equal(lines[0].error_name, "Error");
  });

  it("re-emits the raw error, because our own handler suppresses Node's dump", () => {
    assert.ok(
      result.stderr.includes("boom-uncaught"),
      `the original error was swallowed:\n${result.stderr}`
    );
  });
});

describe("uncaughtException, installed twice", () => {
  // THE BUG. Under `listenerCount > 1` this child logged two `fatal: false`
  // lines and exited 0 — a crashed app still accepting requests.
  const result = crash(
    `installProcessErrorHandlers();
     installProcessErrorHandlers();
     console.log(JSON.stringify({ listeners: process.listeners("uncaughtException").length }));
     ${THROW_LATER}`
  );

  it("registers exactly one listener — install is idempotent", () => {
    const reported = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.equal(reported[0].listeners, 1, result.stdout);
  });

  it("still exits 1", () => {
    assert.equal(result.status, 1, result.stderr);
  });

  it("logs exactly one structured line, still marked fatal", () => {
    const lines = result.lines("uncaught_exception");
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].fatal, true);
  });
});

describe("uncaughtException, with the app's own handler", () => {
  // Registered AFTER install, which is the real order: the README says install
  // fleet-kit as early as possible. The app's handler is a stranger — no marker
  // — so fleet-kit defers to it and the app decides when to go.
  const result = crash(
    `installProcessErrorHandlers();
     process.on("uncaughtException", () => {
       console.log("foreign-handler-ran");
       setTimeout(() => process.exit(0), 50);
     });
     ${THROW_LATER}`
  );

  it("does not exit the process — the app owns its crash semantics", () => {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("foreign-handler-ran"), result.stdout);
  });

  it("logs the line as not fatal", () => {
    const lines = result.lines("uncaught_exception");
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].fatal, false);
  });
});

describe("uncaughtException, two fleet-kit copies at different paths", () => {
  // The case the marker exists for, and the only one the idempotence guard
  // cannot cover: two module instances, two listeners, neither aware of the
  // other's state. Each carries the marker, so each treats the other as kin and
  // the first to run still exits. Under `listenerCount > 1` both deferred and
  // the app survived its own crash.
  const result = crash(
    `import { installProcessErrorHandlers as installSecond } from ${secondCopyUrl()};
     installProcessErrorHandlers();
     installSecond();
     console.log(JSON.stringify({ listeners: process.listeners("uncaughtException").length }));
     ${THROW_LATER}`
  );

  it("really did load two independent instances", () => {
    const reported = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.equal(reported[0].listeners, 2, result.stdout);
  });

  it("exits 1 — kin do not defer to each other", () => {
    assert.equal(result.status, 1, `exit ${result.status}\n${result.stderr}`);
  });

  it("logs fatal:true, once — the first handler exits before the second runs", () => {
    const lines = result.lines("uncaught_exception");
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].fatal, true);
  });
});

describe("unhandledRejection, sole fleet-kit listener", () => {
  const result = crash(`installProcessErrorHandlers();\n${REJECT_LATER}`);

  it("exits 1", () => {
    assert.equal(result.status, 1, result.stderr);
  });

  it("logs one structured unhandled_rejection line marked fatal", () => {
    const lines = result.lines("unhandled_rejection");
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].fatal, true);
  });

  it("re-emits the raw rejection reason", () => {
    assert.ok(result.stderr.includes("boom-rejection"), result.stderr);
  });
});

describe("unhandledRejection, installed twice", () => {
  const result = crash(
    `installProcessErrorHandlers();
     installProcessErrorHandlers();
     ${REJECT_LATER}`
  );

  it("still exits 1, with exactly one structured line", () => {
    assert.equal(result.status, 1, result.stderr);
    const lines = result.lines("unhandled_rejection");
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].fatal, true);
  });
});

describe("unhandledRejection, with the app's own handler", () => {
  const result = crash(
    `installProcessErrorHandlers();
     process.on("unhandledRejection", () => {
       console.log("foreign-handler-ran");
       setTimeout(() => process.exit(0), 50);
     });
     ${REJECT_LATER}`
  );

  it("defers: no exit from fleet-kit, and the line is not fatal", () => {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("foreign-handler-ran"), result.stdout);
    const lines = result.lines("unhandled_rejection");
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].fatal, false);
  });
});
