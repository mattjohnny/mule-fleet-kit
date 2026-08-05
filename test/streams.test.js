// Which stream each level actually lands on.
//
// This runs in a CHILD PROCESS so the parent reads the real file descriptors.
// The original suite tested this in-process by assigning
// `console.warn = () => streams.push("stdout")` and then asserting the pushed
// label was "stdout" — it asserted its own definition, and the definition was
// wrong: Node's `console.warn` is an alias for `console.error` and writes to
// stderr. Docs, test and code all agreed with each other, and none agreed with
// Node.
//
// Any claim of the form "X goes to stream Y" has to be measured from outside the
// process making the claim.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// A bare Windows path is not a legal ESM specifier — it needs a file:// URL.
const distUrl = JSON.stringify(
  pathToFileURL(path.join(here, "..", "dist", "index.js")).href
);

let stdoutEvents;
let stderrEvents;

before(() => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { logEvent } from ${distUrl};
       logEvent("info", "i_am_info");
       logEvent("warn", "i_am_warn");
       logEvent("error", "i_am_error");`,
    ],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);

  const events = (text) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line).event);

  stdoutEvents = events(child.stdout);
  stderrEvents = events(child.stderr);
});

describe("stream routing, measured from outside the process", () => {
  it("puts info on stdout, and nothing else", () => {
    assert.deepEqual(stdoutEvents, ["i_am_info"]);
  });

  it("puts warn and error on stderr", () => {
    assert.deepEqual(stderrEvents, ["i_am_warn", "i_am_error"]);
  });

  it("emits every line exactly once, on exactly one stream", () => {
    const all = [...stdoutEvents, ...stderrEvents].sort();
    assert.deepEqual(all, ["i_am_error", "i_am_info", "i_am_warn"]);
  });
});
