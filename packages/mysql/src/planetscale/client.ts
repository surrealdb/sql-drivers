import {
    type StatementError,
    UnknownResponseError,
    type WireColumn,
} from "@surrealdb/sql-internal";
import {
    type Column,
    connect as connectNative,
    type MysqlConnectOptions,
    type SqlClient,
} from "../native";
import { typeName } from "../types";
import {
    type Cast,
    columnShape,
    cast as defaultCast,
    type Field,
    textOf,
    vitessType,
} from "./cast";
import { type Args, bind } from "./format";

export type { Args };

export interface Config {
    /** `mysql://user:password@host/database?ns=namespace`, as a PlanetScale URL, or a `surrealdb+https://` URL */
    url?: string;
    username?: string;
    password?: string;
    host?: string;
    fetch?: typeof fetch;
    /** Renders a query and its arguments to text on the client; the arguments are then not bound */
    format?: (query: string, args: Args | undefined) => string;
    cast?: Cast;
    /** The SurrealDB namespace, when the URL does not carry an `ns` parameter */
    namespace?: string;
    database?: string;
    transport?: "auto" | "http" | "ws";
    WebSocket?: MysqlConnectOptions["WebSocket"];
    headers?: Record<string, string>;
    /** Per-request timeout in milliseconds */
    timeout?: number;
}

export interface ExecuteOptions {
    as?: "array" | "object";
    cast?: Cast;
}

export type Row<T extends "array" | "object" = "object"> = T extends "array"
    ? unknown[]
    : Record<string, any>;

export interface ExecutedQuery<T = Row> {
    headers: string[];
    types: Record<string, string>;
    fields: Field[];
    rows: T[];
    /** Rows changed by a write; 0 for a query which returns rows */
    rowsAffected: number;
    /** The generated key of an insert, as text; "0" when there is none */
    insertId: string;
    size: number;
    /** The query text as sent, with `?` markers where arguments are bound */
    statement: string;
    /** Milliseconds the instance took */
    time: number;
}

/** A failure reported by the instance. */
export class DatabaseError extends Error {
    override name = "DatabaseError";
    body: { code: string; message: string };
    status: number;
    errno: number | null;
    sqlState: string | null;

    constructor(
        message: string,
        status: number,
        body: { code: string; message: string },
        details: { errno?: number | null; sqlState?: string | null } = {},
    ) {
        super(message);
        this.status = status;
        this.body = body;
        this.errno = details.errno ?? null;
        this.sqlState = details.sqlState ?? null;
    }
}

/** A reply which was not a database reply, as when a proxy answers in place of the instance. */
export class UnknownError extends DatabaseError {
    override name = "UnknownError";
    context: {
        status: number;
        statusText: string;
        body: string;
        headers: Record<string, string>;
    };

    constructor(message: string, context: UnknownError["context"]) {
        super(message, context.status, { code: "UNKNOWN", message });
        this.context = context;
    }
}

const CODES: Record<number, string> = {
    1062: "ALREADY_EXISTS",
    1451: "FAILED_PRECONDITION",
    1452: "FAILED_PRECONDITION",
    1205: "ABORTED",
    1213: "ABORTED",
};

function toDatabaseError(error: StatementError): DatabaseError {
    const code = (error.errno !== null && CODES[error.errno]) || "UNKNOWN";
    return new DatabaseError(
        error.message,
        400,
        { code, message: error.message },
        { errno: error.errno, sqlState: error.sqlstate },
    );
}

function makeField(
    name: string,
    protocolName: string,
    table: string | null,
    column: string | null,
    nullable: boolean | null,
    binary: boolean,
): Field {
    const type = vitessType(protocolName);
    const shape = columnShape(binary && type === "VARCHAR" ? "VARBINARY" : type, nullable);
    return {
        name,
        type,
        table: table ?? undefined,
        orgTable: table,
        database: null,
        orgName: column ?? name,
        ...shape,
        columnType: null,
    };
}

const fieldOfWire = (c: WireColumn) =>
    makeField(c.name, typeName(c), c.table, c.column, c.nullable, c.type.name === "bytea");
const fieldOfColumn = (c: Column) =>
    makeField(c.name, c.typeName, c.table, c.column, c.nullable ?? null, false);

const UNITS: Record<string, number> = { ns: 1e-6, µs: 1e-3, us: 1e-3, ms: 1, s: 1000 };

function milliseconds(time: string, fallback: number): number {
    const m = /^([\d.]+)\s*(ns|µs|us|ms|s)$/.exec(time);
    return m ? Number(m[1]) * UNITS[m[2]] : fallback;
}

interface Queryable {
    query(
        text: string,
        params?: unknown[],
        options?: Record<string, unknown>,
    ): Promise<{
        rows: unknown[];
        columns: Column[];
        rowCount: number;
        insertId: number | string | null;
        time: string;
    }>;
}

/** `execute(query, options)`, the form of version 2 of the PlanetScale driver, which has no arguments. */
function isOptionsOnly(args: unknown): args is ExecuteOptions {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
    const keys = Object.keys(args);
    return (
        keys.length > 0 &&
        keys.every((k) => k === "as" || k === "cast") &&
        ((args as ExecuteOptions).as === undefined ||
            (args as ExecuteOptions).as === "array" ||
            (args as ExecuteOptions).as === "object") &&
        ((args as ExecuteOptions).cast === undefined ||
            typeof (args as ExecuteOptions).cast === "function")
    );
}

async function run<T>(
    target: Queryable,
    config: Config,
    query: string,
    given: Args | ExecuteOptions | undefined,
    options: ExecuteOptions | undefined,
): Promise<ExecutedQuery<T>> {
    let args = given as Args | undefined;
    if (options === undefined && isOptionsOnly(given)) {
        options = given;
        args = undefined;
    }
    const started = Date.now();
    const as = options?.as ?? "object";
    const convert = options?.cast ?? config.cast ?? defaultCast;
    const { text, params } = config.format
        ? { text: config.format(query, args), params: [] }
        : bind(query, args);
    let result: Awaited<ReturnType<Queryable["query"]>>;
    try {
        result = await target.query(text, params, {
            rowMode: as,
            bigint: "string",
            dateStrings: true,
            cast: (column: WireColumn, value: unknown) =>
                convert(fieldOfWire(column), value instanceof Uint8Array ? value : textOf(value)),
        });
    } catch (error) {
        if (error instanceof Error && error.name === "StatementError") {
            throw toDatabaseError(error as StatementError);
        }
        if (error instanceof UnknownResponseError) {
            throw new UnknownError(`Unknown error (HTTP ${error.status})`, {
                status: error.status,
                statusText: error.statusText,
                body: error.body,
                headers: error.headers,
            });
        }
        throw error;
    }
    const fields = result.columns.map(fieldOfColumn);
    const returnsRows = fields.length > 0;
    return {
        headers: fields.map((f) => f.name),
        types: Object.fromEntries(fields.map((f) => [f.name, f.type as string])),
        fields,
        rows: result.rows as T[],
        rowsAffected: returnsRows ? 0 : result.rowCount,
        insertId: String(result.insertId ?? 0),
        size: result.rows.length,
        statement: text,
        time: milliseconds(result.time, Date.now() - started),
    };
}

function connectOptions(config: Config): MysqlConnectOptions {
    let url = config.url;
    if (!url) {
        if (!config.host) throw new TypeError("A `url` or a `host` is required");
        const auth =
            config.username !== undefined
                ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? "")}@`
                : "";
        url = `mysql://${auth}${config.host}/`;
    }
    const options: MysqlConnectOptions = { url, bigint: "string", dateStrings: true };
    if (config.namespace) options.namespace = config.namespace;
    if (config.database) options.database = config.database;
    if (config.fetch) options.fetch = config.fetch;
    if (config.transport) options.transport = config.transport;
    if (config.WebSocket) options.WebSocket = config.WebSocket;
    if (config.headers) options.headers = config.headers;
    if (config.timeout) options.timeout = config.timeout;
    return options;
}

/** What `transaction()` passes to its function: queries on one session. */
export interface Transaction {
    execute<T = Row>(
        query: string,
        args?: Args | ExecuteOptions,
        options?: ExecuteOptions,
    ): Promise<ExecutedQuery<T>>;
}

/**
 * A connection in the shape of the PlanetScale serverless driver. Queries are stateless HTTP
 * calls; `transaction` needs a WebSocket session and throws `UnsupportedOnTransportError` when
 * the configuration pins `transport: "http"`.
 */
export class Connection {
    readonly config: Config;
    #client: SqlClient;

    constructor(config: Config) {
        this.config = { ...config };
        this.#client = connectNative(connectOptions(config));
    }

    async execute<T = Row>(
        query: string,
        args?: Args | ExecuteOptions,
        options?: ExecuteOptions,
    ): Promise<ExecutedQuery<T>> {
        return run<T>(this.#client, this.config, query, args, options);
    }

    transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
        return this.#client.begin((tx) =>
            fn({
                execute: (query, args, options) =>
                    run(tx as unknown as Queryable, this.config, query, args, options),
            }),
        );
    }

    /** Statements are stateless over HTTP, so there is no session to renew. */
    async refresh(): Promise<void> {}
}

export class Client {
    readonly config: Config;
    #connection: Connection;

    constructor(config: Config) {
        this.config = { ...config };
        this.#connection = new Connection(this.config);
    }

    execute<T = Row>(
        query: string,
        args?: Args | ExecuteOptions,
        options?: ExecuteOptions,
    ): Promise<ExecutedQuery<T>> {
        return this.#connection.execute<T>(query, args, options);
    }

    transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
        return this.#connection.transaction(fn);
    }

    connection(): Connection {
        return new Connection(this.config);
    }
}

export function connect(config: Config): Connection {
    return new Connection(config);
}
