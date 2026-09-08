// Emit test-runner events, never text printed by a test or a human reporter.
// Invoke with --test-reporter=<absolute file URL or module path>.
function serializeError(error, seen = new Set()) {
  if (error === null || error === undefined) return error;
  if (typeof error !== "object") return { thrownValueType: typeof error };
  if (seen.has(error)) return { circularCause: true };
  seen.add(error);
  const result = {};
  for (const key of [
    "name", "code", "failureType", "message", "stack", "operator",
    "exitCode", "signal",
  ]) {
    const value = error[key];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      result[key] = value;
    }
  }
  if (error.cause !== undefined) result.cause = serializeError(error.cause, seen);
  return result;
}

export default async function* mutationEvents(source) {
  for await (const event of source) {
    if (event.type !== "test:fail" && event.type !== "test:summary") continue;
    const data = { ...event.data };
    if (data.details) {
      data.details = { ...data.details };
      if (data.details.error !== undefined) {
        data.details.error = serializeError(data.details.error);
      }
    }
    yield `${JSON.stringify({ type: event.type, data })}\n`;
  }
}
