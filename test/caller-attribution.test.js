import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { installRenderCallerAttribution } from "../dist/index.js";

const TEST_PROBE_KEY = "test-probe-key-that-is-at-least-32-characters";

let server;
let origin;

before(async () => {
  const app = express();
  const callerKey = installRenderCallerAttribution(app, {
    probeKey: TEST_PROBE_KEY,
  });

  app.get("/caller", (req, res) => {
    res.json({ ip: req.ip, key: callerKey(req) });
  });
  app.get("/missing-address", (req, res) => {
    Object.defineProperty(req, "ip", { value: undefined });
    Object.defineProperty(req.socket, "remoteAddress", { value: undefined });
    res.json({ key: callerKey(req) });
  });

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(() => server?.close());

async function attribution(forwardedFor, headers = {}) {
  const response = await fetch(`${origin}/caller`, {
    headers: { "x-forwarded-for": forwardedFor, ...headers },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function withServer(app, run) {
  const localServer = app.listen(0, "127.0.0.1");
  await once(localServer, "listening");
  try {
    const address = localServer.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    localServer.close();
  }
}

async function statusAt(appOrigin, forwardedFor) {
  return fetch(`${appOrigin}/limited`, {
    headers: { "x-forwarded-for": `${forwardedFor}, 198.51.100.20` },
  }).then((response) => response.status);
}

describe("installRenderCallerAttribution", () => {
  it("uses the verified Render caller and ignores caller-prepended forwarding data", async () => {
    const ordinary = await attribution("203.0.113.10, 198.51.100.20");
    const spoofed = await attribution(
      "192.0.2.77, 203.0.113.10, 198.51.100.20",
    );

    assert.equal(ordinary.ip, "203.0.113.10");
    assert.equal(spoofed.ip, ordinary.ip);
    assert.equal(spoofed.key, ordinary.key);
  });

  it("uses maintained IPv4 and IPv6 normalization and one stable unknown bucket", async () => {
    const mappedIpv4 = await attribution(
      "::ffff:203.0.113.4, 198.51.100.20",
    );
    const ipv6A = await attribution(
      "2001:db8:abcd:1234::1, 198.51.100.20",
    );
    const ipv6B = await attribution(
      "2001:db8:abcd:1234:ffff::9, 198.51.100.20",
    );
    const otherIpv6 = await attribution(
      "2001:db8:abce::1, 198.51.100.20",
    );
    const missingA = await fetch(`${origin}/missing-address`).then((response) =>
      response.json(),
    );
    const missingB = await fetch(`${origin}/missing-address`).then((response) =>
      response.json(),
    );

    assert.equal(mappedIpv4.key, "203.0.113.4");
    assert.equal(ipv6A.key, "2001:db8:abcd:1200::/56");
    assert.equal(ipv6B.key, ipv6A.key);
    assert.notEqual(otherIpv6.key, ipv6A.key);
    assert.deepEqual(missingA, { key: "unknown" });
    assert.deepEqual(missingB, missingA);
  });

  it("supplies the caller key to a fleet-style custom limiter", async () => {
    const app = express();
    const callerKey = installRenderCallerAttribution(app, {
      probeKey: TEST_PROBE_KEY,
    });
    const counts = new Map();
    app.get("/limited", (req, res) => {
      const key = callerKey(req);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      res.sendStatus(count > 1 ? 429 : 200);
    });

    await withServer(app, async (appOrigin) => {
      assert.equal(await statusAt(appOrigin, "203.0.113.60"), 200);
      assert.equal(await statusAt(appOrigin, "203.0.113.60"), 429);
      assert.equal(await statusAt(appOrigin, "203.0.113.61"), 200);
    });
  });

  it("works directly as an express-rate-limit keyGenerator", async () => {
    const app = express();
    const callerKey = installRenderCallerAttribution(app, {
      probeKey: TEST_PROBE_KEY,
    });
    app.use(
      "/limited",
      rateLimit({
        windowMs: 60_000,
        limit: 1,
        keyGenerator: callerKey,
        standardHeaders: false,
        legacyHeaders: false,
      }),
    );
    app.get("/limited", (_req, res) => res.sendStatus(200));

    await withServer(app, async (appOrigin) => {
      assert.equal(await statusAt(appOrigin, "203.0.113.70"), 200);
      assert.equal(await statusAt(appOrigin, "203.0.113.70"), 429);
      assert.equal(await statusAt(appOrigin, "203.0.113.71"), 200);
    });
  });

  it("refuses a conflicting proxy configuration without overwriting it", () => {
    const app = express();
    app.set("trust proxy", 1);

    assert.throws(
      () =>
        installRenderCallerAttribution(app, {
          probeKey: TEST_PROBE_KEY,
        }),
      /conflicting Express trust proxy configuration/,
    );
    assert.equal(app.get("trust proxy"), 1);
  });

  it("fails startup when an explicitly configured probe credential is unsafe", () => {
    assert.throws(
      () =>
        installRenderCallerAttribution(express(), {
          probeKey: "short",
        }),
      /probe credential must be at least 32 characters/,
    );
    assert.throws(
      () =>
        installRenderCallerAttribution(express(), {
          probeKey: "   ",
        }),
      /probe credential must be at least 32 characters/,
    );
  });

  it("keeps attribution active and emits one safe warning when the probe credential is missing", async () => {
    const app = express();
    const warningLines = [];
    const realError = console.error;
    let callerKey;
    try {
      console.error = (line) => warningLines.push(String(line));
      callerKey = installRenderCallerAttribution(app);
    } finally {
      console.error = realError;
    }

    app.get("/caller", (req, res) => res.json({ key: callerKey(req) }));
    const localServer = app.listen(0, "127.0.0.1");
    await once(localServer, "listening");
    try {
      const address = localServer.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/caller`, {
        headers: { "x-forwarded-for": "203.0.113.44, 198.51.100.20" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { key: "203.0.113.44" });
    } finally {
      localServer.close();
    }

    assert.equal(warningLines.length, 1);
    const warning = JSON.parse(warningLines[0]);
    assert.equal(warning.level, "warn");
    assert.equal(warning.event, "caller_attribution_probe_disabled");
    assert.ok(!warningLines[0].includes("203.0.113.44"));
  });

  it("emits only stable per-process opaque references for authorized probes", async () => {
    const infoLines = [];
    const realLog = console.log;
    try {
      console.log = (line) => infoLines.push(String(line));
      await attribution("203.0.113.10, 198.51.100.20", {
        "x-rate-limit-probe": TEST_PROBE_KEY,
      });
      await attribution("192.0.2.77, 203.0.113.10, 198.51.100.20", {
        "x-rate-limit-probe": TEST_PROBE_KEY,
      });
      await attribution("203.0.113.11, 198.51.100.20", {
        "x-rate-limit-probe": TEST_PROBE_KEY,
      });
    } finally {
      console.log = realLog;
    }

    const probes = infoLines.map((line) => JSON.parse(line));
    assert.equal(probes.length, 3);
    assert.ok(probes.every((line) => line.event === "caller_attribution_probe"));
    assert.match(probes[0].selected_key_ref, /^[a-f0-9]{16}$/);
    assert.equal(probes[1].selected_key_ref, probes[0].selected_key_ref);
    assert.notEqual(probes[2].selected_key_ref, probes[0].selected_key_ref);

    const output = infoLines.join("\n");
    for (const sensitive of [
      TEST_PROBE_KEY,
      "192.0.2.77",
      "203.0.113.10",
      "203.0.113.11",
      "198.51.100.20",
      "127.0.0.1",
    ]) {
      assert.ok(!output.includes(sensitive), `probe output contained ${sensitive}`);
    }
  });

  it("reveals no probe telemetry without exact authorization", async () => {
    const infoLines = [];
    const realLog = console.log;
    try {
      console.log = (line) => infoLines.push(String(line));
      await attribution("203.0.113.10, 198.51.100.20");
      await attribution("203.0.113.10, 198.51.100.20", {
        "x-rate-limit-probe": `${TEST_PROBE_KEY.slice(0, -1)}x`,
      });
    } finally {
      console.log = realLog;
    }

    assert.deepEqual(infoLines, []);
  });
});
