export * from "./abort";
export * from "./auth";
export * from "./client-core";
export * from "./config";
export * from "./contract";
export * from "./emitter";
export * from "./encode";
export * from "./errors";
export * from "./http";
export * from "./rpc-error";
export * from "./run";
export * from "./statement";
export * from "./transport";
export * from "./ws";

import type { ResolvedConfig } from "./config";
import { HttpTransport } from "./http";
import type { Transport } from "./transport";
import { WsTransport } from "./ws";

/**
 * The transports for a resolved config: HTTP for one-shot work and a WebSocket for sessions.
 * With `transport: "auto"` both exist and the caller picks by need; a pinned transport has only
 * one of them.
 */
export function createTransports(config: ResolvedConfig): { http?: Transport; ws?: Transport } {
    const out: { http?: Transport; ws?: Transport } = {};
    if (config.transport !== "ws") out.http = new HttpTransport(config);
    if (config.transport !== "http") out.ws = new WsTransport(config);
    return out;
}
