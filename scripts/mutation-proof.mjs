// Classification consumes structured records and semantic test-runner events.
// A failing compiler or test harness is never evidence that a test caught a bug.
function processProblem(record, label) {
  if (!record || typeof record !== "object") return `${label} record is missing`;
  if (record.signal != null) return `${label} ended with signal ${record.signal}`;
  if (record.errorCode != null || record.error != null) return `${label} had a spawn or execution error`;
  if (!Number.isInteger(record.status)) return `${label} has no exit status`;
  return undefined;
}

function bodyAssertion(event) {
  const details = event.data?.details;
  const error = details?.error;
  const cause = error?.cause;
  return details?.type === "test"
    && error?.code === "ERR_TEST_FAILURE"
    && error.failureType === "testCodeFailure"
    && cause?.name === "AssertionError"
    && cause.code === "ERR_ASSERTION"
    && typeof cause.operator === "string";
}

/**
 * Records: { status: number|null, signal?: string|null, errorCode?: string|null,
 *            error?: unknown }. Events are parsed mutation-events.mjs JSONL.
 * Unknown, incomplete, or mixed harness failures are invalid, never kills.
 */
export function classifyMutation(buildRecord, testRecord, events) {
  const invalid = (reason) => ({ outcome: "invalid", reason });
  const buildProblem = processProblem(buildRecord, "build");
  if (buildProblem) return invalid(buildProblem);
  if (buildRecord.status !== 0) return invalid("build did not succeed");
  const testProblem = processProblem(testRecord, "test process");
  if (testProblem) return invalid(testProblem);
  if (testRecord.status !== 0 && testRecord.status !== 1) {
    return invalid(`test process exited ${testRecord.status}, expected 0 or 1`);
  }
  if (!Array.isArray(events) || events.some((event) =>
    !event || !["test:fail", "test:summary"].includes(event.type)
      || !event.data || typeof event.data !== "object" || Array.isArray(event.data))) {
    return invalid("test event stream is missing or malformed");
  }
  const summaries = events.filter((event) => event.type === "test:summary");
  if (summaries.some((event) => event.data.file !== undefined && typeof event.data.file !== "string")) {
    return invalid("summary file identity is malformed");
  }
  const globalSummaries = summaries.filter((event) => !event.data.file);
  if (globalSummaries.length !== 1) return invalid("one completed run summary is required");
  const summary = globalSummaries[0].data;
  const countKeys = ["tests", "failed", "passed", "cancelled", "skipped", "todo"];
  if (summaries.some(({ data }) => !data.counts || countKeys.some((key) =>
    !Number.isInteger(data.counts[key]) || data.counts[key] < 0)
      || typeof data.success !== "boolean")) {
    return invalid("run summary is malformed");
  }
  const fileSummaries = summaries.filter((event) => typeof event.data.file === "string");
  if (fileSummaries.length < 1) return invalid("completed per-file summaries are required");
  // The runner counts an empty/filtered file wrapper as one passing test.
  // Its per-file summary exposes that no test body actually ran.
  const executed = fileSummaries.reduce((total, event) =>
    total + event.data.counts.passed + event.data.counts.failed, 0);
  if (summary.counts.tests < 1 || executed < 1) {
    return invalid("run summary does not prove any tests completed");
  }
  for (const key of countKeys) {
    const fileTotal = fileSummaries.reduce((total, event) => total + event.data.counts[key], 0);
    if (fileTotal !== summary.counts[key]) return invalid("file summaries disagree with run counts");
  }
  if (events.at(-1) !== globalSummaries[0]) return invalid("run summary is not the final event");
  if (summaries.some((event) => event.data.counts?.cancelled > 0)) {
    return invalid("test run includes cancellation");
  }
  const failures = events.filter((event) => event.type === "test:fail");
  for (const event of failures) {
    const details = event.data.details;
    const error = details?.error;
    if (error?.code === "ERR_TEST_FAILURE" && error.failureType === "subtestsFailed"
        && ["test", "suite"].includes(details.type)) continue;
    if (!bodyAssertion(event)) {
      return invalid(`non-assertion or harness failure: ${error?.failureType ?? "unknown"}`);
    }
  }
  const failedTests = failures.filter((event) => event.data.details?.type === "test").length;
  if (failedTests !== summary.counts.failed) return invalid("failure events disagree with run counts");
  if (testRecord.status === 0) {
    if (!summary.success || failures.length !== 0 || summary.counts.failed !== 0) {
      return invalid("successful exit disagrees with test events");
    }
    return { outcome: "survived", reason: "build and test suite passed" };
  }
  if (summary.success || !(summary.counts.failed > 0)) {
    return invalid("failing exit disagrees with test events");
  }
  if (!failures.some(bodyAssertion)) return invalid("no test-body assertion failed");
  return { outcome: "killed", reason: "test-body assertion failed after a successful build" };
}
