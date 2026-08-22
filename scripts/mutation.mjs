// Mutation testing: break the implementation on purpose, and require the suite
// to notice.
//
// This exists because v0.1.0 shipped 25 passing tests that constrained almost
// nothing — 12 of 18 deliberate breakages survived them, including "always log
// status 500" and "read the error message as well as the stack". A suite that
// has never been mutation-tested is not evidence, and the fleet's verification
// bar now says so in writing (mule-fleet-docs/standards.md).
//
// Each mutation below is a defect that was either found in review or would be a
// real regression. If any SURVIVES, the suite has a hole at exactly that point.
//
//   node scripts/mutation.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (name) => path.join(root, "src", name);

// Anchors below are written with LF. A Windows checkout stores CRLF, so every
// multi-line anchor would silently miss — and a missed anchor reads as a
// surviving mutation, i.e. a false alarm that hides real ones.
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);

const MUTATIONS = [
  {
    name: "errorSite reads the message as well as the stack (the data leak)",
    file: "errors.ts",
    from: "  const lines = stackBody(error, stack).split(\"\\n\", MAX_STACK_LINES);",
    to: "  const lines = stack.split(\"\\n\", MAX_STACK_LINES);",
  },
  {
    name: "errorSite accepts any line, not just frames (forgeable site)",
    file: "errors.ts",
    from: '    if (!trimmed.startsWith("at ")) continue;',
    to: '    if (false) continue;',
  },
  {
    name: "crash ownership is decided by listener count again (nobody exits)",
    file: "errors.ts",
    from: "  const ownedElsewhere = foreignOwnerExists(signal);",
    to: "  const ownedElsewhere = process.listenerCount(signal) > 1;",
  },
  {
    name: "installProcessErrorHandlers is no longer idempotent",
    file: "errors.ts",
    from: "  if (processHandlersInstalled) return;\n  processHandlersInstalled = true;",
    to: "",
  },
  {
    name: "error status is always 500",
    file: "errors.ts",
    from: "    const status = intendedStatus(error, res);",
    to: "    const status = 500;",
  },
  {
    name: "error level ignores the status (every 4xx is level:error)",
    file: "errors.ts",
    from: '    logEvent(status >= 500 ? "error" : "warn", "unhandled_error", {',
    to: '    logEvent("error", "unhandled_error", {',
  },
  {
    name: "safeErrorName rejects every app error class",
    file: "errors.ts",
    from: "  return looksLikeClassName(candidate) ? candidate : \"Error\";",
    to: "  return \"Error\";",
  },
  {
    name: "errorFields can throw again",
    file: "errors.ts",
    from: "  try {\n    return { error_name: safeErrorName(error), error_site: errorSite(error) };",
    to: "  if (true) {\n    return { error_name: safeErrorName(error), error_site: errorSite(error) };",
  },
  {
    name: "logEvent throws on unserializable values",
    file: "telemetry.ts",
    from: "    return JSON.stringify(payload, safeReplacer()) ?? \"{}\";",
    to: "    return JSON.stringify(payload) ?? \"{}\";",
  },
  {
    name: "caller fields can overwrite the envelope",
    file: "telemetry.ts",
    from: "    payload[RESERVED_FIELDS.has(key) ? `field_${key}` : key] = value;",
    to: "    payload[key] = value;",
  },
  {
    name: "warn goes to stdout",
    file: "telemetry.ts",
    from: "  if (level === \"info\") console.log(line);\n  else console.error(line);",
    to: "  if (level === \"error\") console.error(line);\n  else console.log(line);",
  },
  {
    name: "successful health checks are logged again (the 98% noise)",
    file: "telemetry.ts",
    from: "      if (!aborted && quiet.has(req.path) && res.statusCode < 400) return;",
    to: "      if (false) return;",
  },
  {
    name: "a failing health check is silently dropped",
    file: "telemetry.ts",
    from: "      if (!aborted && quiet.has(req.path) && res.statusCode < 400) return;",
    to: "      if (quiet.has(req.path)) return;",
  },
  {
    name: "aborted requests are not logged",
    file: "telemetry.ts",
    from: '    res.once("close", emit);',
    to: "    void emit;",
  },
  {
    name: "aborted requests are not flagged as aborted",
    file: "telemetry.ts",
    from: "        ...(aborted ? { aborted: true } : {}),",
    to: "",
  },
  {
    name: "the request id header is not set",
    file: "telemetry.ts",
    from: '    res.setHeader("X-Request-ID", id);',
    to: "",
  },
  {
    name: "an inbound request id is ignored",
    file: "telemetry.ts",
    from: '    const id = requestHeader(req, "x-request-id") || crypto.randomUUID();',
    to: "    const id = crypto.randomUUID();",
  },
  {
    name: "one request logs two lines",
    file: "telemetry.ts",
    from: "      if (settled) return;\n      settled = true;",
    to: "      settled = true;",
  },
  {
    name: "the heartbeat is pinged even when the job failed",
    file: "jobs.ts",
    from: "    await pingHeartbeat(options.heartbeatUrl, job);\n    return result;",
    to: "    return result;",
    extra: {
      from: '      duration_ms: Date.now() - started,\n      ...errorFields(error),\n    });\n    throw error;',
      to: '      duration_ms: Date.now() - started,\n      ...errorFields(error),\n    });\n    await pingHeartbeat(options.heartbeatUrl, job);\n    throw error;',
    },
  },
  {
    name: "path secrets are no longer redacted (capability tokens in logs)",
    file: "telemetry.ts",
    from: "        path: redactPath(req.path),",
    to: "        path: req.path,",
  },
  {
    name: "redactPath eats ordinary readable paths",
    file: "telemetry.ts",
    from: "  if (segment.length < 24) return false;",
    to: "  if (segment.length < 4) return false;",
  },
  {
    name: "the heartbeat sends GET instead of POST",
    file: "jobs.ts",
    from: '      method: "POST",',
    to: '      method: "GET",',
  },
  {
    name: "pingHeartbeat can reject",
    file: "jobs.ts",
    from: "  } catch (error) {\n    // The URL carries a heartbeat token, so it is never logged — only the fact.\n    logEvent(\"warn\", \"heartbeat_ping_failed\", { job, ...errorFields(error) });",
    to: "  } catch (error) {\n    throw error;\n    logEvent(\"warn\", \"heartbeat_ping_failed\", { job, ...errorFields(error) });",
  },
  {
    name: "runTrackedJob swallows the job's error instead of re-throwing",
    file: "jobs.ts",
    from: "    throw error;\n  }\n}",
    to: "    return undefined as T;\n  }\n}",
  },
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...opts });
}

/** `npm` is a .cmd shim on Windows, which execFileSync cannot exec directly. */
function build() {
  return run("npm", ["run", "build"], { shell: process.platform === "win32" });
}

function suitePasses() {
  try {
    build();
  } catch {
    return { passed: false, reason: "build failed" };
  }
  try {
    run(process.execPath, [
      "--test",
      "test/express.test.js",
      "test/fatal.test.js",
      "test/hygiene.test.js",
      "test/jobs.test.js",
      "test/streams.test.js",
    ]);
    return { passed: true };
  } catch {
    return { passed: false, reason: "tests failed" };
  }
}

const originals = new Map();
for (const name of ["errors.ts", "telemetry.ts", "jobs.ts"]) {
  originals.set(name, fs.readFileSync(file(name), "utf8"));
}
const restore = () => {
  for (const [name, text] of originals) fs.writeFileSync(file(name), text);
};

process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

console.log("Baseline: the suite must pass before any mutation is meaningful.");
const baseline = suitePasses();
if (!baseline.passed) {
  console.error(`  BASELINE FAILS (${baseline.reason}) — fix that first.`);
  process.exit(2);
}
console.log("  baseline green\n");

const survivors = [];
for (const mutation of MUTATIONS) {
  restore();
  const target = file(mutation.file);
  // Normalize CRLF before matching: multi-line anchors silently miss on
  // Windows checkouts otherwise, and a stale anchor reads as a survivor.
  let text = fs.readFileSync(target, "utf8").split(CRLF).join(LF);

  if (!text.includes(mutation.from)) {
    console.log(`??  ${mutation.name}\n    (anchor not found — mutation is stale)`);
    survivors.push({ ...mutation, stale: true });
    continue;
  }
  text = text.replace(mutation.from, mutation.to);
  if (mutation.extra) text = text.replace(mutation.extra.from, mutation.extra.to);
  fs.writeFileSync(target, text);

  const result = suitePasses();
  if (result.passed) {
    console.log(`!!  SURVIVED  ${mutation.name}`);
    survivors.push(mutation);
  } else {
    console.log(`ok  killed    ${mutation.name}`);
  }
}

restore();
build();

console.log(
  `\n${MUTATIONS.length - survivors.length}/${MUTATIONS.length} mutations killed.`
);
if (survivors.length > 0) {
  console.log("\nSurvivors — the suite does not constrain these:");
  for (const s of survivors) console.log(`  - ${s.name}${s.stale ? " (stale anchor)" : ""}`);
  process.exit(1);
}
console.log("Every deliberate breakage was caught.");
