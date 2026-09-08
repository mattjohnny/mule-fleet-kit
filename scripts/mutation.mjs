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

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyMutation } from "./mutation-proof.mjs";

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
    name: "errorFields reads a hostile name before its safety boundary",
    file: "errors.ts",
    from: "export function errorFields(error: unknown): Record<string, unknown> {\n  try {\n    return { error_name: safeErrorName(error), error_site: errorSite(error) };",
    to: "export function errorFields(error: unknown): Record<string, unknown> {\n  const name = (error as { name?: unknown } | null)?.name;\n  try {\n    return { error_name: safeErrorName({ name }), error_site: errorSite(error) };",
  },
  {
    name: "the terminal handler puts the error in the response body (the leak)",
    file: "terminal-error.ts",
    from: "    res.status(status).json({ error: houseMessage(status) });",
    to: "    res.status(status).json({ error: houseMessage(status), detail: String(error) });",
  },
  {
    name: "the terminal handler answers 500 for everything",
    file: "terminal-error.ts",
    from: "    const status = intendedStatus(error, res);",
    to: "    const status = 500;",
  },
  {
    name: "the terminal handler answers over a response that already started",
    file: "terminal-error.ts",
    from: "    if (res.headersSent) {\n      res.destroy();\n      return;\n    }\n\n",
    to: "",
  },
  {
    name: "the framework fingerprint is advertised again",
    file: "terminal-error.ts",
    from: '  app.disable("x-powered-by");\n\n',
    to: "",
  },
  {
    name: "the terminal handler derives its own status (answered drifts from logged)",
    file: "terminal-error.ts",
    from: 'import { intendedStatus } from "./errors.js";',
    to:
      "function intendedStatus(_error: unknown, res: Response): number {\n" +
      "  return res.statusCode >= 400 ? res.statusCode : 500;\n" +
      "}",
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
    from: '  res.setHeader("X-Request-ID", id);',
    to: "",
  },
  {
    name: "an inbound request id is ignored",
    file: "telemetry.ts",
    from:
      '  const id =\n    requestId(res) || requestHeader(req, "x-request-id") || crypto.randomUUID();',
    to: "  const id = requestId(res) || crypto.randomUUID();",
  },
  {
    name: "request telemetry replaces an earlier probe correlation id",
    file: "telemetry.ts",
    from:
      '  const id =\n    requestId(res) || requestHeader(req, "x-request-id") || crypto.randomUUID();',
    to:
      '  const id =\n    requestHeader(req, "x-request-id") || crypto.randomUUID();',
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
  {
    name: "Render trusts a caller-prepended forwarding hop",
    file: "caller-attribution.ts",
    from: "const RENDER_TRUSTED_PROXY_HOPS = 2;",
    to: "const RENDER_TRUSTED_PROXY_HOPS = 3;",
  },
  {
    name: "caller addresses bypass maintained normalization",
    file: "caller-attribution.ts",
    from:
      '    const selected = ipKeyGenerator(\n      request.ip || request.socket.remoteAddress || "unknown",\n    );',
    to:
      '    const selected = request.ip || request.socket.remoteAddress || "unknown";',
  },
  {
    name: "missing caller addresses split into random buckets",
    file: "caller-attribution.ts",
    from: '      request.ip || request.socket.remoteAddress || "unknown",',
    to: "      request.ip || request.socket.remoteAddress || crypto.randomUUID(),",
  },
  {
    name: "conflicting proxy configuration is accepted",
    file: "caller-attribution.ts",
    from:
      "  if (existingTrust !== false && existingTrust !== RENDER_TRUSTED_PROXY_HOPS) {",
    to: "  if (false) {",
  },
  {
    name: "an exactly empty probe credential crashes startup again (D23)",
    file: "caller-attribution.ts",
    from: '  const configuredProbeKey = options.probeKey === "" ? undefined : options.probeKey;',
    to: "  const configuredProbeKey = options.probeKey;",
  },
  {
    name: "the valid 32-character probe credential boundary is rejected",
    file: "caller-attribution.ts",
    from: "probeKey.length < 32",
    to: "probeKey.length <= 32",
  },
  {
    name: "configured probe credentials no longer trim surrounding whitespace",
    file: "caller-attribution.ts",
    from: "  const probeKey = configuredProbeKey?.trim();",
    to: "  const probeKey = configuredProbeKey;",
  },
  {
    name: "an unsafe probe credential is accepted",
    file: "caller-attribution.ts",
    from:
      "  if (configuredProbeKey !== undefined && (!probeKey || probeKey.length < 32)) {",
    to: "  if (false) {",
  },
  {
    name: "the missing probe credential warning is suppressed",
    file: "caller-attribution.ts",
    from: "  if (!probeKey) {",
    to: "  if (false) {",
  },
  {
    name: "a same-length incorrect probe credential is authorized",
    file: "caller-attribution.ts",
    from: "    crypto.timingSafeEqual(suppliedBytes, expectedBytes)",
    to: "    true",
  },
  {
    name: "authorized probe telemetry leaks the selected caller address",
    file: "caller-attribution.ts",
    from: "    selected_key_ref: opaqueReference(selected),",
    to: "    selected_key_ref: selected,",
  },
  {
    name: "authorized probe telemetry cannot correlate to its request",
    file: "caller-attribution.ts",
    from: "    request_id: requestIdValue,",
    to: "",
  },
  {
    name: "authorized probe telemetry accepts an unbounded forwarding chain",
    file: "caller-attribution.ts",
    from: "    .filter(Boolean)\n    .slice(-8);",
    to: "    .filter(Boolean);",
  },
  {
    name: "installer-only apps cannot produce authorized probe evidence",
    file: "caller-attribution.ts",
    from: '  if (probeKey) {\n    app.use((request, response, next) => {',
    to: '  if (probeKey && Boolean(false)) {\n    app.use((request, response, next) => {',
  },
  {
    name: "probe authorization is revealed by the request-id response header",
    file: "caller-attribution.ts",
    from: "      const requestIdValue = ensureRequestId(request, response);",
    to:
      '      const requestIdValue = probeAuthorized(request, probeKey)\n        ? ensureRequestId(request, response)\n        : "";',
  },
  {
    name: "caller-key consumers collapse every caller into one limiter bucket",
    file: "caller-attribution.ts",
    from: "    return selected;",
    to: '    return "one-caller";',
  },
];

// Keep evidence outside the package, and never overwrite an earlier campaign.
const evidence = process.env.MULE_MUTATION_PROOF_DIR
  ? path.resolve(process.env.MULE_MUTATION_PROOF_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), "fleet-kit-mutations-"));
fs.mkdirSync(evidence, { recursive: true });
assert.equal(fs.readdirSync(evidence).length, 0, "mutation evidence directory must be empty");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const save = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n");
const originals = new Map([...new Set(MUTATIONS.map((mutation) => mutation.file))]
  .map((name) => [file(name), fs.readFileSync(file(name))]));
const emitted = new Map(fs.readdirSync(path.join(root, "dist"))
  .map((name) => path.join(root, "dist", name))
  .map((name) => [name, fs.readFileSync(name)]));
function restore(files = originals) {
  for (const [name, bytes] of files) {
    if (!fs.existsSync(name) || !fs.readFileSync(name).equals(bytes)) {
      fs.mkdirSync(path.dirname(name), { recursive: true });
      fs.writeFileSync(name, bytes);
    }
  }
}
let completed = false;
process.on("exit", () => {
  if (!completed) { restore(); restore(emitted); }
});
for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    restore();
    restore(emitted);
    save("interrupted.json", { signal, status, restored: true });
    process.exit(status);
  });
}

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8", stdio: "pipe", timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024, ...options,
  });
  const record = {
    command, args, status: result.status, signal: result.signal,
    errorCode: result.error?.code ?? null, error: result.error?.stack ?? null,
  };
  const output = `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\n${JSON.stringify(record)}\n`;
  fs.writeFileSync(path.join(evidence, `${name}.log`), output);
  save(`${name}.json`, record);
  // CI retains diagnostics even when its temporary filesystem disappears.
  process.stdout.write(output);
  return record;
}
function build(name) {
  return run(name, "npm", ["run", "build"], { shell: process.platform === "win32" });
}
function suite(name) {
  const buildRecord = build(`${name}-build`);
  if (buildRecord.status !== 0 || buildRecord.signal || buildRecord.error) {
    return classifyMutation(buildRecord, null, []);
  }
  const eventPath = path.join(evidence, `${name}-events.jsonl`);
  const testRecord = run(`${name}-tests`, process.execPath, [
    "--test", "--test-reporter=tap",
    `--test-reporter=${pathToFileURL(path.join(root, "scripts/mutation-events.mjs")).href}`,
    "--test-reporter-destination=stdout", `--test-reporter-destination=${eventPath}`,
    "test/express.test.js", "test/fatal.test.js", "test/hygiene.test.js",
    "test/jobs.test.js", "test/streams.test.js", "test/caller-attribution.test.js",
    "test/terminal-error.test.js",
  ]);
  let events;
  try {
    const raw = fs.readFileSync(eventPath, "utf8");
    process.stdout.write(raw);
    events = raw.trim().split("\n").map((line) => JSON.parse(line));
  } catch (error) {
    fs.writeFileSync(path.join(evidence, `${name}-event-error.log`), String(error.stack));
    return { outcome: "invalid", reason: "test event stream could not be read or parsed" };
  }
  return classifyMutation(buildRecord, testRecord, events);
}

const results = [];
let baseline;
let restoredBuild;
let fatalError;
console.log(`Mutation evidence: ${evidence}`);
save("runtime.json", { node: process.version, platform: process.platform, versions: process.versions });
save("original-hashes.json", Object.fromEntries([...originals].map(([name, bytes]) => [path.relative(root, name), sha256(bytes)])));
try {
  baseline = suite("baseline");
  assert.equal(baseline.outcome, "survived", `baseline must pass: ${baseline.reason}`);
  for (const [index, mutation] of MUTATIONS.entries()) {
    restore();
    const name = `mutation-${String(index + 1).padStart(2, "0")}`;
    const target = file(mutation.file);
    let text = originals.get(target).toString("utf8").split(CRLF).join(LF);
    try {
      for (const replacement of [mutation, ...(mutation.extra ? [mutation.extra] : [])]) {
        assert.equal(text.split(replacement.from).length, 2, "mutation anchor must occur exactly once");
        text = text.replace(replacement.from, replacement.to);
      }
      assert.notEqual(sha256(text), sha256(originals.get(target)), "mutation must change source");
      fs.writeFileSync(target, text);
      fs.writeFileSync(path.join(evidence, `${name}-${mutation.file}`), text);
      const diff = run(`${name}-diff`, "git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "diff", "--", "src"]);
      assert.equal(diff.status, 0, "applied diff must be recorded");
      assert.equal(diff.error, null);
      assert.equal(diff.signal, null);
      results.push({ name: mutation.name, evidence: name, mutatedHash: sha256(text), ...suite(name) });
    } catch (error) {
      fs.writeFileSync(path.join(evidence, `${name}-runner-error.log`), String(error.stack));
      results.push({ name: mutation.name, evidence: name, outcome: "invalid", reason: String(error) });
    } finally {
      restore();
      results.at(-1).restoredHash = sha256(fs.readFileSync(target));
      assert.deepEqual(fs.readFileSync(target), originals.get(target), "source must be restored");
      save("results.json", results);
    }
    console.log(`${results.at(-1).outcome}: ${mutation.name} (${results.at(-1).reason})`);
  }
} catch (error) {
  fatalError = String(error.stack);
  console.error(fatalError);
} finally {
  restore();
  restoredBuild = build("restored-build");
  const restoration = [...originals].map(([name, bytes]) => ({
    path: path.relative(root, name), originalHash: sha256(bytes),
    restoredHash: sha256(fs.readFileSync(name)), identical: fs.readFileSync(name).equals(bytes),
  }));
  const emittedRestoration = [...emitted].map(([name, bytes]) => ({
    path: path.relative(root, name), originalHash: sha256(bytes),
    restoredHash: fs.existsSync(name) ? sha256(fs.readFileSync(name)) : null,
    identical: fs.existsSync(name) && fs.readFileSync(name).equals(bytes),
  }));
  save("restoration.json", { sources: restoration, emitted: emittedRestoration, build: restoredBuild });
  assert.ok(restoration.every((entry) => entry.identical), "all source bytes must be restored");
  completed = restoredBuild.status === 0 && !restoredBuild.signal && !restoredBuild.error
    && emittedRestoration.every((entry) => entry.identical);
  if (!completed) console.error("Restored build or emitted-byte restoration failed; see restoration.json");
}
const killed = results.filter((result) => result.outcome === "killed").length;
const success = !fatalError && baseline?.outcome === "survived" && completed
  && results.length === MUTATIONS.length && killed === MUTATIONS.length;
save("summary.json", { success, total: MUTATIONS.length, killed, baseline, restoredBuild, fatalError, results });
console.log(`\n${killed}/${MUTATIONS.length} assertion-backed kills. Evidence: ${evidence}`);
if (!success) {
  for (const result of results.filter((result) => result.outcome !== "killed")) {
    console.error(`${result.outcome}: ${result.name}: ${result.reason}`);
  }
  process.exitCode = 1;
}
