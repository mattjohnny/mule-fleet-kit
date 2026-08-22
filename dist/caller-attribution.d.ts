import type { Express, Request } from "express";
export interface RenderCallerAttributionOptions {
    probeKey?: string;
}
export type CallerKey = (request: Request) => string;
/** Install the verified Render proxy topology and return its normalized caller key. */
export declare function installRenderCallerAttribution(app: Express, options?: RenderCallerAttributionOptions): CallerKey;
