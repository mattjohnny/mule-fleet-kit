// The hygiene guarantees, and the ways they were actually broken.
//
// Every test here corresponds to a defect a review reproduced against v0.1.0.
// If one of these ever goes green after an implementation change, the change is
// wrong — not the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { performance } from "node:perf_hooks";

import {
  errorFields,
  errorSite,
  logEvent,
  redactPath,
  safeErrorName,
} from "../dist/index.js";

function captured(run) {
  const lines = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try {
    run();
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return lines.map((l) => JSON.parse(l));
}

// --- the leak --------------------------------------------------------------

describe("error messages never reach the log", () => {
  // v0.1.0 selected frames by position (`stack.split("\n").slice(1)`), so a
  // message containing a newline became lines that the frame parser then read.
  it("a multi-line message carrying personal data does not leak", () => {
    const error = new Error(
      "import failed for row:\nstaff,wage,site\nmj@otherbird.com,31.50,burro:12:1"
    );
    const emitted = JSON.stringify(errorFields(error));
    assert.ok(!emitted.includes("otherbird.com"), emitted);
    assert.ok(!emitted.includes("31.50"), emitted);
    assert.ok(!emitted.includes("burro"), emitted);
  });

  it("a message shaped exactly like a file location does not leak", () => {
    const error = new Error("invalid staff record\n/data/wages/mj@otherbird.com:41200:1");
    const emitted = JSON.stringify(errorFields(error));
    assert.ok(!emitted.includes("otherbird.com"), emitted);
  });

  it("a message carrying a credential does not leak", () => {
    const error = new Error("auth failed\ntoken sk-live-9f3a2b/portal:1:1");
    const emitted = JSON.stringify(errorFields(error));
    assert.ok(!emitted.includes("sk-live-9f3a2b"), emitted);
  });

  // The other half of the same bug: the one diagnostic the package keeps must
  // not be forgeable by a caller-supplied string.
  it("error_site cannot be forged from the message", () => {
    const error = new Error(
      "bad input\n    at handler (/opt/render/project/src/src/payroll.ts:9999:1)"
    );
    const site = errorSite(error);
    assert.ok(
      site === undefined || !site.includes("payroll"),
      `forged site was emitted: ${site}`
    );
  });

  // The forgery guard has two independent layers, and this covers the second.
  // When the stack has been reassigned so the message cannot be located in it,
  // the header cannot be cut by length and the only thing standing between a
  // caller-supplied line and the log is the `at ` frame-shape check. Mutation
  // testing found this path untested: removing that check left the suite green.
  it("cannot be forged even when the message is not locatable in the stack", () => {
    const error = new Error("real message");
    // Simulates a rewritten stack (a bundler, a framework, Sentry) whose header
    // no longer contains `error.message`.
    error.stack =
      "SomethingElse: different text\n" +
      "/etc/passwd:1:1\n" +
      "    at real (/opt/render/project/src/src/db.ts:7:1)";
    const site = errorSite(error);
    assert.ok(!site || !site.includes("passwd"), `leaked a non-frame line: ${site}`);
  });

  it("still reports a genuine site from a real error", () => {
    const site = errorSite(new Error("ordinary"));
    assert.ok(site, "a real error should still yield a location");
    assert.match(site, /^[^\s]+:\d+$/);
  });
});

// --- the denial of service ---------------------------------------------------

describe("errorSite is linear, not quadratic", () => {
  // v0.1.0 used /([^\s()]+):(\d+):\d+\)?\s*$/. 19 KB took over a second and a
  // 60 KB message blocked the event loop for 12.8 seconds.
  it("a hostile 200 KB stack line completes in milliseconds", () => {
    const hostile = new Error("boom");
    hostile.stack = "Error: boom\n    at x (" + "99999:".repeat(34_000) + "(";

    const started = performance.now();
    errorSite(hostile);
    const elapsed = performance.now() - started;

    assert.ok(elapsed < 250, `errorSite took ${elapsed.toFixed(0)}ms on a 200KB frame`);
  });

  it("scales linearly, not quadratically, with input size", () => {
    const time = (repeats) => {
      const error = new Error("boom");
      error.stack = "Error: boom\n    at x (" + "99999:".repeat(repeats) + "(";
      const started = performance.now();
      errorSite(error);
      return performance.now() - started;
    };
    time(2_000); // warm
    const small = Math.max(time(4_000), 0.05);
    const large = time(32_000); // 8x the input
    assert.ok(large / small < 24, `8x input cost ${(large / small).toFixed(1)}x time`);
  });
});

// --- logEvent must never throw -----------------------------------------------

describe("logEvent cannot throw", () => {
  // A throw here killed the process from a `finish` listener, and silently
  // prevented a nightly job from running at all.
  it("survives a BigInt", () => {
    const lines = captured(() => logEvent("info", "t", { cents: 10n }));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].cents, "10n");
  });

  it("survives a circular object", () => {
    const circular = { name: "x" };
    circular.self = circular;
    const lines = captured(() => logEvent("info", "t", { circular }));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].circular.self, "[circular]");
  });

  it("survives a throwing toJSON, keeping the envelope", () => {
    const hostile = { toJSON() { throw new Error("nope"); } };
    const lines = captured(() => logEvent("error", "job_failed", { hostile, job: "nightly" }));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "job_failed");
    assert.equal(lines[0].job, "nightly");
    assert.equal(lines[0].unserializable_fields, 1);
  });
});

describe("the envelope cannot be overwritten", () => {
  it("a caller field named level or event is prefixed, not applied", () => {
    const lines = captured(() =>
      logEvent("error", "unhandled_error", { level: "info", event: "nothing_to_see" })
    );
    assert.equal(lines[0].level, "error");
    assert.equal(lines[0].event, "unhandled_error");
    assert.equal(lines[0].field_level, "info");
    assert.equal(lines[0].field_event, "nothing_to_see");
  });
});

// --- error names -------------------------------------------------------------

describe("safeErrorName", () => {
  it("keeps an app's own error class, which the allow-list used to discard", () => {
    class DomainError extends Error {}
    const error = new DomainError("x");
    error.name = "DomainError";
    assert.equal(safeErrorName(error), "DomainError");
  });

  it("collapses a name carrying a message or interpolated data", () => {
    const error = new Error("x");
    error.name = "AccessDenied: arn:aws:secretsmanager:12345:secret:mule/prod-Ab3xY";
    assert.equal(safeErrorName(error), "Error");
  });

  it("collapses an over-long name", () => {
    const error = new Error("x");
    error.name = "A".repeat(200);
    assert.equal(safeErrorName(error), "Error");
  });

  it("survives a throwing name getter", () => {
    const error = {};
    Object.defineProperty(error, "name", { get() { throw new Error("nope"); } });
    assert.equal(safeErrorName(error), "Error");
  });
});

describe("errorFields never throws", () => {
  // This runs inside the uncaughtException handler; a throw there exited 7 with
  // no structured line at all.
  it("survives an error whose stack and name both throw", () => {
    const hostile = {};
    Object.defineProperty(hostile, "stack", { get() { throw new Error("stack"); } });
    Object.defineProperty(hostile, "name", { get() { throw new Error("name"); } });
    const fields = errorFields(hostile);
    assert.equal(fields.error_name, "Error");
  });
});

// --- secrets in the path ------------------------------------------------------

describe("redactPath", () => {
  // mule-quarterly routes reports at /reports/<64-hex HMAC>, which its own docs
  // call keyed pseudonyms. Every bookmark and refresh wrote one to the log.
  it("redacts a capability token in a path segment", () => {
    const token = "a3f5c1e9b7d24680a3f5c1e9b7d24680a3f5c1e9b7d24680a3f5c1e9b7d24680";
    assert.equal(redactPath(`/reports/${token}`), "/reports/:id");
  });

  it("redacts a UUID", () => {
    assert.equal(redactPath("/api/shift/550e8400-e29b-41d4-a716-446655440000"), "/api/shift/:id");
  });

  it("redacts a long mixed-case opaque token", () => {
    assert.equal(redactPath("/d/xK9mQ2vB7nR4tY6wZ1aS3dF5"), "/d/:id");
  });

  it("leaves ordinary readable paths alone", () => {
    assert.equal(redactPath("/api/locations/burlington"), "/api/locations/burlington");
    assert.equal(redactPath("/menu/seasonal-autumn-tasting"), "/menu/seasonal-autumn-tasting");
    assert.equal(redactPath("/health"), "/health");
    assert.equal(redactPath("/api/reports/2026-08-05"), "/api/reports/2026-08-05");
  });

  it("leaves short ids readable, so ordinary debugging still works", () => {
    assert.equal(redactPath("/api/entry/4821"), "/api/entry/4821");
  });
});

describe("redactPath keeps short readable segments", () => {
  // Guards the length threshold: dropping it would redact ordinary segments and
  // make every log line useless for debugging.
  it("leaves a short mixed-case-and-digit segment alone", () => {
    assert.equal(redactPath("/api/wk/A1b2"), "/api/wk/A1b2");
    assert.equal(redactPath("/loc/Burro2"), "/loc/Burro2");
  });

  // Between the two length gates (16 and 24). Mixed case and digits, but far too
  // short to be an opaque token — a real name. The lower gate masks the upper
  // one for anything under 16 characters, so this is the only length band that
  // actually exercises the 24-character threshold.
  it("leaves a readable name in the 16-23 character band alone", () => {
    for (const name of ["Autumn2026MenuSpec", "Burlington2026Xyz", "Q3Report2026Draft"]) {
      // Assert the fixture is in the band, rather than trusting a hand count —
      // the first two attempts at this test were silently under 16 characters
      // and so were masked by the lower gate, letting the mutation survive.
      assert.ok(
        name.length >= 16 && name.length < 24,
        `fixture "${name}" is ${name.length} chars, outside the band this test exists to cover`
      );
      assert.equal(redactPath(`/x/${name}`), `/x/${name}`);
    }
  });
});
