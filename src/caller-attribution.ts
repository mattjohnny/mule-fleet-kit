import crypto from "node:crypto";
import type { Express, Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { logEvent } from "./telemetry.js";

// Render's public path is caller -> Cloudflare -> Render proxy -> app. Trusting
// exactly those two infrastructure hops makes Express ignore any forwarding
// value the caller prepends outside that chain.
const RENDER_TRUSTED_PROXY_HOPS = 2;
const probeReferenceKey = crypto.randomBytes(32);

export interface RenderCallerAttributionOptions {
  probeKey?: string;
}

export type CallerKey = (request: Request) => string;

function opaqueReference(value: string): string {
  return crypto
    .createHmac("sha256", probeReferenceKey)
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function probeAuthorized(request: Request, expected: string): boolean {
  const supplied = request.get("x-rate-limit-probe")?.trim() ?? "";
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function logAuthorizedProbe(request: Request, selected: string): void {
  const forwardedHops = (request.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean)
    .slice(-8);
  logEvent("info", "caller_attribution_probe", {
    selected_key_ref: opaqueReference(selected),
    request_ip_ref: opaqueReference(request.ip ?? ""),
    socket_ip_ref: opaqueReference(request.socket.remoteAddress ?? ""),
    forwarded_hop_refs: forwardedHops.map(opaqueReference),
    forwarded_hop_count: forwardedHops.length,
  });
}

/** Install the verified Render proxy topology and return its normalized caller key. */
export function installRenderCallerAttribution(
  app: Express,
  options: RenderCallerAttributionOptions = {},
): CallerKey {
  const configuredProbeKey = options.probeKey;
  const probeKey = configuredProbeKey?.trim();
  if (configuredProbeKey !== undefined && (!probeKey || probeKey.length < 32)) {
    throw new Error(
      "installRenderCallerAttribution probe credential must be at least 32 characters",
    );
  }

  const existingTrust = app.get("trust proxy");
  if (existingTrust !== false && existingTrust !== RENDER_TRUSTED_PROXY_HOPS) {
    throw new Error(
      "installRenderCallerAttribution found a conflicting Express trust proxy configuration",
    );
  }
  if (existingTrust === false) {
    app.set("trust proxy", RENDER_TRUSTED_PROXY_HOPS);
  }
  if (!probeKey) {
    logEvent("warn", "caller_attribution_probe_disabled");
  }
  const callerKey: CallerKey = (request) => {
    const selected = ipKeyGenerator(
      request.ip || request.socket.remoteAddress || "unknown",
    );
    return selected;
  };
  if (probeKey) {
    app.use((request, _response, next) => {
      if (probeAuthorized(request, probeKey)) {
        logAuthorizedProbe(request, callerKey(request));
      }
      next();
    });
  }
  return callerKey;
}
