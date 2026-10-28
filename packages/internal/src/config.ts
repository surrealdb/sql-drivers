export type Dialect = "pg" | "mysql";

export interface UserCredentials {
    username: string;
    password: string;
    namespace?: string;
    database?: string;
}

export interface RecordCredentials {
    access: string;
    variables?: Record<string, unknown>;
    namespace?: string;
    database?: string;
}

export interface TokenCredentials {
    token: string;
}

export type Credentials = UserCredentials | RecordCredentials | TokenCredentials;

export interface ReconnectOptions {
    enabled: boolean;
    attempts: number;
    retryDelay: number;
    retryDelayMax: number;
    retryDelayMultiplier: number;
    retryDelayJitter: number;
}

export const DEFAULT_RECONNECT: ReconnectOptions = {
    enabled: true,
    attempts: 5,
    retryDelay: 1000,
    retryDelayMax: 60000,
    retryDelayMultiplier: 2,
    retryDelayJitter: 0.1,
};

export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

export interface ConnectOptions {
    /** Connection string; see `parseConnectionString` */
    url?: string;
    namespace?: string;
    database?: string;
    auth?: Credentials | (() => Credentials | string | Promise<Credentials | string>);
    /** How a user and password are presented over HTTP: Basic on every call, or one signin */
    authMode?: "basic" | "token";
    transport?: "auto" | "http" | "ws";
    codec?: "json";
    /** Default per-request timeout in milliseconds */
    timeout?: number;
    reconnect?: Partial<ReconnectOptions> | boolean;
    fetch?: typeof fetch;
    WebSocket?: WebSocketConstructor;
    headers?: Record<string, string>;
    /** Dialect settings sent as `SET` statements, for example `{ timezone: "UTC" }` */
    settings?: Record<string, string | number | boolean>;
}

export interface ResolvedConfig {
    httpEndpoint: string;
    wsEndpoint: string;
    namespace: string | undefined;
    database: string | undefined;
    auth: ConnectOptions["auth"];
    authMode: "basic" | "token";
    transport: "auto" | "http" | "ws";
    codec: "json";
    timeout: number | undefined;
    reconnect: ReconnectOptions;
    fetch: typeof fetch | undefined;
    WebSocket: WebSocketConstructor | undefined;
    headers: Record<string, string>;
    settings: Record<string, string | number | boolean>;
}

export interface ParsedConnectionString {
    secure: boolean | undefined;
    host: string;
    port: string;
    namespace?: string;
    database?: string;
    username?: string;
    password?: string;
    transport?: "auto" | "http" | "ws";
    timeout?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Parse a connection string.
 *
 * - `surrealdb[+http|+https|+ws|+wss]://[user[:pass]@]host[:port]/<namespace>/<database>`
 * - `postgres://` and `postgresql://` (for the pg dialect) and `mysql://` (for the mysql
 *   dialect): the path is the database and the namespace is the `namespace` or `ns` parameter.
 *   The port is ignored unless the scheme pins one with a `+` suffix.
 *
 * Query parameters `namespace`, `ns`, `database`, `db`, `transport` and `timeout` are read.
 */
export function parseConnectionString(input: string, dialect: Dialect): ParsedConnectionString {
    const match = /^([a-z][a-z0-9]*)(?:\+([a-z]+))?:\/\/(.*)$/i.exec(input.trim());
    if (!match) throw new TypeError(`Invalid connection string: expected scheme://host`);
    const scheme = match[1].toLowerCase();
    const suffix = match[2]?.toLowerCase();
    const allowed =
        dialect === "pg" ? ["surrealdb", "postgres", "postgresql"] : ["surrealdb", "mysql"];
    if (!allowed.includes(scheme)) {
        throw new TypeError(`Unsupported scheme "${scheme}" for the ${dialect} dialect`);
    }
    if (suffix && !["http", "https", "ws", "wss"].includes(suffix)) {
        throw new TypeError(`Unsupported scheme suffix "+${suffix}"`);
    }

    // Parse the rest as an http URL so userinfo, host and query are handled by the platform
    const url = new URL(`http://${match[3]}`);
    const params = url.searchParams;
    const segments = url.pathname
        .split("/")
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));

    const parsed: ParsedConnectionString = {
        secure: suffix ? suffix === "https" || suffix === "wss" : undefined,
        host: url.hostname,
        port: scheme === "surrealdb" || suffix ? url.port : "",
    };
    if (url.username) parsed.username = decodeURIComponent(url.username);
    if (url.password) parsed.password = decodeURIComponent(url.password);

    if (scheme === "surrealdb") {
        if (segments[0]) parsed.namespace = segments[0];
        if (segments[1]) parsed.database = segments[1];
    } else if (segments[0]) {
        parsed.database = segments[0];
    }
    const ns = params.get("namespace") ?? params.get("ns");
    const db = params.get("database") ?? params.get("db");
    if (ns) parsed.namespace = ns;
    if (db) parsed.database = db;

    const transport = params.get("transport");
    if (transport) {
        if (transport !== "auto" && transport !== "http" && transport !== "ws") {
            throw new TypeError(`Unsupported transport "${transport}"`);
        }
        parsed.transport = transport;
    }
    const timeout = params.get("timeout");
    if (timeout) {
        const n = Number(timeout);
        if (!Number.isFinite(n) || n <= 0) throw new TypeError(`Invalid timeout "${timeout}"`);
        parsed.timeout = n;
    }
    if (suffix === "ws" || suffix === "wss") parsed.transport ??= "ws";
    return parsed;
}

/** Whether a host gets TLS by default: everything except loopback. */
export function defaultSecure(host: string): boolean {
    return !LOCAL_HOSTS.has(host.toLowerCase());
}

export function resolveConfig(
    input: string | ConnectOptions,
    dialect: Dialect,
    overrides: ConnectOptions = {},
): ResolvedConfig {
    const options: ConnectOptions = typeof input === "string" ? { url: input } : { ...input };
    Object.assign(options, overrides);
    if (!options.url) throw new TypeError("A connection string or `url` is required");

    const parsed = parseConnectionString(options.url, dialect);
    const secure = parsed.secure ?? defaultSecure(parsed.host);
    const authority =
        parsed.host.includes(":") && !parsed.host.startsWith("[")
            ? `[${parsed.host}]`
            : parsed.host;
    const hostPort = parsed.port ? `${authority}:${parsed.port}` : authority;

    let auth = options.auth;
    if (auth === undefined && parsed.username !== undefined) {
        auth = { username: parsed.username, password: parsed.password ?? "" };
    }

    const reconnect =
        typeof options.reconnect === "boolean"
            ? { ...DEFAULT_RECONNECT, enabled: options.reconnect }
            : { ...DEFAULT_RECONNECT, ...options.reconnect };

    return {
        httpEndpoint: `${secure ? "https" : "http"}://${hostPort}`,
        wsEndpoint: `${secure ? "wss" : "ws"}://${hostPort}`,
        namespace: options.namespace ?? parsed.namespace,
        database: options.database ?? parsed.database,
        auth,
        authMode: options.authMode ?? "basic",
        transport: options.transport ?? parsed.transport ?? "auto",
        codec: options.codec ?? "json",
        timeout: options.timeout ?? parsed.timeout,
        reconnect,
        fetch: options.fetch,
        WebSocket: options.WebSocket,
        headers: options.headers ?? {},
        settings: options.settings ?? {},
    };
}

/** The delay before reconnect attempt `attempt`, the first of which is 1. */
export function backoffDelay(options: ReconnectOptions, attempt: number): number {
    const jitter = (Math.random() * 2 - 1) * options.retryDelayJitter;
    const delay = options.retryDelay * options.retryDelayMultiplier ** attempt * (1 + jitter);
    return Math.min(delay, options.retryDelayMax);
}
