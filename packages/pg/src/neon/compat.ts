import type { ClientConfig } from "../compat/index";

/** The fields of a PostgreSQL error response which `NeonDbError` and `DatabaseError` carry. */
export const errorFields = [
    "severity",
    "code",
    "detail",
    "hint",
    "position",
    "internalPosition",
    "internalQuery",
    "where",
    "schema",
    "table",
    "column",
    "dataType",
    "constraint",
    "file",
    "line",
    "routine",
] as const;

/** The node-postgres connection defaults. */
export const defaults = {
    host: "localhost",
    user: (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.USER,
    database: undefined as string | undefined,
    password: null as string | null,
    connectionString: undefined as string | undefined,
    port: 5432,
    rows: 0,
    binary: false,
    max: 10,
    idleTimeoutMillis: 30000,
    client_encoding: "",
    ssl: false,
    application_name: undefined as string | undefined,
    fallback_application_name: undefined as string | undefined,
    connect_timeout: 0,
    statement_timeout: false as number | false,
    lock_timeout: false as number | false,
    idle_in_transaction_session_timeout: false as number | false,
    query_timeout: false as number | false,
    keepalives: 1,
    keepalives_idle: 0,
    parseInputDatesAsUTC: false,
};

/** Turn a connection string into the parameters of a `Client`, as `pg-connection-string` does. */
export function parseIntoClientConfig(connectionString: string): ClientConfig {
    const url = new URL(connectionString);
    const config: ClientConfig = {};
    if (url.username) config.user = decodeURIComponent(url.username);
    if (url.password) config.password = decodeURIComponent(url.password);
    if (url.hostname) config.host = decodeURIComponent(url.hostname);
    if (url.port) config.port = Number(url.port);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (database) config.database = database;
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode && sslmode !== "disable") config.ssl = true;
    const application = url.searchParams.get("application_name");
    if (application) (config as { application_name?: string }).application_name = application;
    return config;
}

/** Neon prints a warning when its driver runs in a browser; this package has nothing to warn about. */
export function warnIfBrowser(): void {}
