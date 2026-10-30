import type { WebSocketConstructor } from "@surrealdb/sql-internal";

/**
 * The settings object of `@neondatabase/serverless`. Fields marked as honoured change behaviour
 * of this package; the others are accepted so code written for that package runs unchanged, and
 * have no effect because the transports here carry no PostgreSQL wire protocol.
 */
export interface NeonConfig {
    /** Honoured: the WebSocket class used by `Client` and `Pool` from `@surrealdb/pg/neon` */
    webSocketConstructor: WebSocketConstructor | undefined;
    /** Honoured: replaces the `fetch` used by `neon()` */
    fetchFunction: typeof fetch | undefined;
    /**
     * Honoured: the URL `neon()` posts to, or a function from host and port to that URL. The
     * target must speak the `pgsql` RPC contract, not Neon's `/sql` protocol.
     */
    fetchEndpoint:
        | string
        | ((host: string, port: number | string, options?: { jwtAuth?: boolean }) => string)
        | undefined;
    wsProxy: string | ((host: string, port: number | string) => string) | undefined;
    useSecureWebSocket: boolean;
    forceDisablePgSSL: boolean;
    coalesceWrites: boolean;
    pipelineConnect: "password" | false;
    pipelineTLS: boolean;
    disableSNI: boolean;
    fetchConnectionCache: boolean;
    poolQueryViaFetch: boolean;
    subtls: unknown;
    rootCerts: string;
    [key: string]: unknown;
}

/** Process-wide settings, read each time a request or a client is made. */
export const neonConfig: NeonConfig = {
    webSocketConstructor: undefined,
    fetchFunction: undefined,
    fetchEndpoint: undefined,
    wsProxy: undefined,
    useSecureWebSocket: true,
    forceDisablePgSSL: true,
    coalesceWrites: true,
    pipelineConnect: "password",
    pipelineTLS: false,
    disableSNI: false,
    fetchConnectionCache: true,
    poolQueryViaFetch: false,
    subtls: undefined,
    rootCerts: "",
};
