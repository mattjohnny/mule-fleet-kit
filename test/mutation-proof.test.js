import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyMutation } from "../scripts/mutation-proof.mjs";

const reporter = new URL("../scripts/mutation-events.mjs", import.meta.url).href;
const evidenceBase = process.env.MUTATION_HELPER_PROOF_DIR;
const temporaryBase = path.resolve(evidenceBase || os.tmpdir());
fs.mkdirSync(temporaryBase, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(temporaryBase, "classifier-fixtures-"));
after(() => {
  if (evidenceBase) return;
  if (path.dirname(path.resolve(fixtureRoot)) !== temporaryBase) {
    throw new Error("refusing to remove fixtures outside their temporary parent");
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const buildOK = { status: 0, signal: null, errorCode: null };
let fixtureId = 0;
function runFixture(name, sources, options = {}) {
  const { extraArgs = [], ...spawnOptions } = options;
  const fixturePath = path.join(fixtureRoot, `${++fixtureId}-${name}`);
  fs.mkdirSync(fixturePath);
  const files = sources.map((source, index) => {
    const file = path.join(fixturePath, `case-${index}.test.mjs`);
    fs.writeFileSync(file, source);
    return file;
  });
  const eventsFile = path.join(fixturePath, "events.jsonl");
  // Each fixture needs its own runner, not the enclosing runner's worker mode.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", `--test-reporter=${reporter}`,
    "--test-reporter-destination=stdout", `--test-reporter-destination=${eventsFile}`,
    ...extraArgs, ...files,
  ], { encoding: "utf8", env: childEnv, timeout: 10_000, maxBuffer: 2_000_000, ...spawnOptions });
  const record = {
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
  };
  const eventsText = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8") : "";
  const events = eventsText.split(/\r?\n/).filter(Boolean).map(JSON.parse);
  fs.writeFileSync(path.join(fixturePath, "stdout.tap"), result.stdout || "");
  fs.writeFileSync(path.join(fixturePath, "stderr.log"), result.stderr || "");
  fs.writeFileSync(path.join(fixturePath, "process.json"), JSON.stringify(record, null, 2));
  return { record, events, result, fixturePath };
}

const assertBody = `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('actual body assertion', () => assert.equal(1, 2));`;
const greenBody = `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('passing body', () => assert.equal(1, 1));`;

function expectOutcome(name, sources, outcome, options) {
  const proof = runFixture(name, sources, options);
  assert.ok(proof.events.some((event) => event.type === "test:summary" && !event.data.file),
    `${name} must actually run and complete: ${proof.result.stderr}`);
  assert.equal(proof.record.errorCode, null, `${name} must not pass by spawn failure or timeout`);
  assert.equal(proof.record.signal, null, `${name} runner must complete`);
  assert.match(proof.result.stdout, /TAP version 13/);
  const classified = classifyMutation(buildOK, proof.record, proof.events);
  assert.equal(classified.outcome, outcome,
    `${name}: ${JSON.stringify(classified)}\n${JSON.stringify(proof.events)}\n${proof.result.stderr}`);
  return proof;
}

test("classifies a genuine child test-body assertion as killed", () => {
  const proof = expectOutcome("body-assertion", [assertBody], "killed");
  const failure = proof.events.find((event) => event.type === "test:fail");
  assert.equal(failure.data.details.type, "test");
  assert.equal(failure.data.details.error.cause.code, "ERR_ASSERTION");
  assert.equal(failure.data.details.error.cause.operator, "strictEqual");
  assert.match(failure.data.details.error.cause.stack, /case-0\.test\.mjs/);
});

test("accepts structural subtestsFailed parents around a body assertion", () => {
  expectOutcome("nested-body", [`import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
describe('parent suite', () => it('body', () => assert.equal(1, 2)));`], "killed");
});

test("accepts a structural failed parent test around a child assertion", () => {
  expectOutcome("nested-test", [`import assert from 'node:assert/strict';
import { test } from 'node:test';
test('parent test', async (t) => {
  await t.test('child body', () => assert.equal(1, 2));
});`], "killed");
});

test("classifies a completed green child run as survived", () => {
  expectOutcome("green", [greenBody], "survived");
});

test("ignores assertion-looking text printed by passing tests", () => {
  expectOutcome("printed-fake", [`import { test } from 'node:test';
test('printing is not failure', () => {
  console.log('ERR_ASSERTION AssertionError strictEqual');
  console.log(JSON.stringify({ type: 'test:fail', data: { details: { type: 'test',
    error: { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure',
      cause: { name: 'AssertionError', code: 'ERR_ASSERTION', operator: 'strictEqual' } } } } }));
});`], "survived");
});

test("rejects hook assertion failures even alongside a body assertion", () => {
  expectOutcome("hook", [assertBody, `import assert from 'node:assert/strict';
import { before, test } from 'node:test';
before(() => assert.equal(1, 2));
test('body never runs', () => {});`], "invalid");
});

test("rejects module load failures even alongside a body assertion", () => {
  expectOutcome("module-load", [assertBody, `import './does-not-exist.mjs';`], "invalid");
});

test("rejects top-level setup assertions even alongside a body assertion", () => {
  expectOutcome("top-level-setup", [assertBody, `import assert from 'node:assert/strict';
assert.equal(1, 2);`], "invalid");
});

test("rejects ordinary test errors that merely mention ERR_ASSERTION", () => {
  expectOutcome("ordinary-error", [`import { test } from 'node:test';
test('ordinary error', () => { throw new Error('AssertionError ERR_ASSERTION strictEqual'); });`], "invalid");
});

test("rejects suite-definition assertions even alongside a body assertion", () => {
  expectOutcome("suite-definition", [assertBody, `import assert from 'node:assert/strict';
import { describe } from 'node:test';
describe('definition', () => assert.equal(1, 2));`], "invalid");
});

test("rejects cancellation even alongside a body assertion", () => {
  const proof = expectOutcome("cancelled", [assertBody, `import { test } from 'node:test';
const controller = new AbortController();
test('cancelled body', { signal: controller.signal }, () => new Promise(() => {}));
controller.abort();`], "invalid");
  assert.ok(proof.events.some((event) => event.type === 'test:summary'
    && event.data.counts.cancelled > 0));
});

test("rejects a test timeout even alongside a body assertion", () => {
  expectOutcome("test-timeout", [assertBody, `import { test } from 'node:test';
test('times out', { timeout: 30 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
});`], "invalid");
});

test("rejects a child-process timeout", () => {
  const proof = runFixture("process-timeout", [`import { test } from 'node:test';
test('never completes', async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
});`], { timeout: 500 });
  assert.equal(proof.record.errorCode, "ETIMEDOUT");
  assert.equal(classifyMutation(buildOK, proof.record, proof.events).outcome, "invalid");
});

test("rejects a child terminated by a signal", () => {
  expectOutcome("signal", [`import { test } from 'node:test';
test('terminates', () => process.kill(process.pid, 'SIGTERM'));`], "invalid");
});

test("rejects build refusal and process errors despite real assertion events", () => {
  const proof = runFixture("process-record-boundaries", [assertBody]);
  for (const record of [
    { status: 1, signal: null, errorCode: null },
    { status: null, signal: "SIGTERM", errorCode: null },
    { status: null, signal: null, errorCode: "ETIMEDOUT" },
    { status: null, signal: null, errorCode: "ENOENT" },
  ]) {
    assert.equal(classifyMutation(record, proof.record, proof.events).outcome, "invalid");
  }
  for (const record of [
    { status: 1, signal: "SIGTERM", errorCode: null },
    { status: 1, signal: null, errorCode: "ETIMEDOUT" },
    { status: 1, signal: null, errorCode: "ENOENT" },
    { status: 1, signal: null, error: new Error("spawn failed") },
    { status: 1, signal: "", errorCode: null },
    { status: 1, signal: null, errorCode: "" },
  ]) {
    assert.equal(classifyMutation(buildOK, record, proof.events).outcome, "invalid");
  }
});

test("rejects a real syntax-check build refusal despite valid assertion evidence", () => {
  const proof = runFixture("build-refused", [assertBody]);
  const invalidSource = path.join(proof.fixturePath, "invalid-build.mjs");
  fs.writeFileSync(invalidSource, "export const = ;\n");
  const result = spawnSync(process.execPath, ["--check", invalidSource], { encoding: "utf8" });
  const record = { status: result.status, signal: result.signal, errorCode: result.error?.code ?? null };
  fs.writeFileSync(path.join(proof.fixturePath, "build-stderr.log"), result.stderr || "");
  fs.writeFileSync(path.join(proof.fixturePath, "build-process.json"), JSON.stringify(record));
  assert.equal(record.status, 1);
  assert.equal(classifyMutation(record, proof.record, proof.events).outcome, "invalid");
});

test("rejects completed runs with no executed tests", () => {
  const proof = expectOutcome("zero-tests", [greenBody], "invalid", {
    extraArgs: ["--test-name-pattern=does-not-match-any-test"],
  });
  const fileSummary = proof.events.find((event) => event.type === "test:summary" && event.data.file);
  assert.equal(fileSummary.data.counts.passed + fileSummary.data.counts.failed, 0);
});

test("rejects absent or truncated event streams", () => {
  const proof = runFixture("truncated-events", [assertBody]);
  assert.equal(classifyMutation(buildOK, proof.record, []).outcome, "invalid");
  assert.equal(classifyMutation(buildOK, proof.record,
    proof.events.filter((event) => event.type !== "test:summary")).outcome, "invalid");
  assert.equal(classifyMutation(buildOK, proof.record,
    proof.events.filter((event) => event.type !== "test:fail")).outcome, "invalid");
  assert.equal(classifyMutation(buildOK, proof.record,
    [{ type: "test:fail" }]).outcome, "invalid");
  assert.equal(classifyMutation(buildOK, proof.record,
    [proof.events.at(-1), ...proof.events.slice(0, -1)]).outcome, "invalid");
});
