import {
    buildVars,
    Emitter,
    HttpTransport,
    resolveConfig,
    SqlSession,
    StatementError,
    type ResolvedConfig,
    type Transport,
    type WireColumn,
    type WireResponse,
    WsTransport,
} from "@surrealdb/sql-internal";
import { oidByName } from "../oids";
import { settingStatements, type PgConnectOptions } from "../native";
import { type ParserFormat, type TextParser, types as defaultTypes } from "../text-types";
import { DatabaseError } from "./errors";

export interface TypesLike {
    getTypeParser(oid: number, format?: ParserFormat): TextParser;
}

export interface QueryConfig {
    text: string;
    values?: unknown[];
    name?: string;
    rowMode?: "array";
    types?: TypesLike;
    queryMode?: "simple" | "extended";
    query_timeout?: number;
}

export interface FieldDef {
    name: string;
    tableID: number;
    columnID: number;
    dataTypeID: number;
    dataTypeSize: number;
    dataTypeModifier: number;
    format: string;
}

export interface QueryResult<R = unknown> {
    command: string;
    rowCount: number | null;
    oid: number | null;
    rows: R[];
    fields: FieldDef[];
}

export interface ClientConfig extends PgConnectOptions {
    connectionString?: string;
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    database?: string;
    ssl?: boolean | object;
    query_timeout?: number;
    statement_timeout?: number;
    application_name?: string;
    types?: TypesLike;
    // Accepted so a pool can pass its whole option set through
    [key: string]: unknown;
}

type Callback<T> = (error: Error | null, result?: T) => void;

/** Turn node-postgres style config into connect options for the SurrealDB resolver. */
export function toConnectOptions(config: ClientConfig): PgConnectOptions {
    const options: PgConnectOptions = { ...(config as PgConnectOptions) };
    if (!options.url) {
        if (config.connectionString) options.url = config.connectionString;
        else if (config.host) {
            const secure = config.ssl ? "+https" : config.port ? "+http" : "";
            const auth = config.user
                ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password ?? "")}@`
                : "";
            const port = config.port ? `:${config.port}` : "";
            const scheme = secure ? `surrealdb${secure}` : "postgres";
            options.url = `${scheme}://${auth}${config.host}${port}/${config.database ?? ""}`;
            if (scheme === "surrealdb+http" || scheme === "surrealdb+https") {
                // The native scheme reads namespace/database from the path; keep the pg meaning
                options.url = `${scheme}://${auth}${config.host}${port}/`;
                if (config.database) options.database = config.database;
            }
        }
    }
    const settings: Record<string, string | number | boolean> = { ...config.settings };
    if (config.application_name) settings.application_name = config.application_name;
    if (config.statement_timeout) settings.statement_timeout = config.statement_timeout;
    if (Object.keys(settings).length > 0) options.settings = settings;
    return options;
}

const COMMAND_RE = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;

export function parseCommandTag(tag: string): { command: string; rowCount: number | null; oid: number | null } {
    const m = COMMAND_RE.exec(tag);
    if (!m) return { command: tag, rowCount: null, oid: null };
    if (m[1] === "INSERT" && m[3] !== undefined) {
        return { command: "INSERT", oid: Number(m[2]), rowCount: Number(m[3]) };
    }
    return { command: m[1], oid: null, rowCount: m[2] !== undefined ? Number(m[2]) : null };
}

function toField(c: WireColumn): FieldDef {
    const name = c.type.name ?? "";
    // The wire reports built-in OIDs; anything unknown is text, which every consumer accepts
    const oid = c.type.oid ?? oidByName[name] ?? 25;
    return {
        name: c.name,
        tableID: 0,
        columnID: 0,
        dataTypeID: oid,
        dataTypeSize: -1,
        dataTypeModifier: -1,
        format: "text",
    };
}

export function toQueryResults(
    response: WireResponse,
    config: Pick<QueryConfig, "rowMode" | "types">,
): QueryResult[] {
    const parsers = config.types ?? defaultTypes;
    const out: QueryResult[] = [];
    for (const statement of response.statements) {
        if (statement.status === "ERR") {
            throw DatabaseError.from(new StatementError(statement.error ?? { message: "error" }));
        }
        const columns = statement.columns ?? [];
        const fields = columns.map(toField);
        const parse = fields.map((f) => parsers.getTypeParser(f.dataTypeID, "text"));
        const rows = (statement.rows ?? []).map((raw) => {
            const cells = Array.isArray(raw)
                ? raw
                : columns.map((c) => (raw as Record<string, unknown>)[c.name]);
            const values = cells.map((cell, i) =>
                cell === null || cell === undefined ? null : parse[i](String(cell)),
            );
            if (config.rowMode === "array") return values;
            const obj: Record<string, unknown> = {};
            fields.forEach((f, i) => {
                obj[f.name] = values[i];
            });
            return obj;
        });
        const { command, rowCount, oid } = parseCommandTag(statement.command?.tag ?? "");
        out.push({
            command,
            rowCount: rowCount ?? (columns.length > 0 ? rows.length : null),
            oid,
            rows,
            fields,
        });
    }
    return out;
}

export function normalizeQueryArgs(
    a: string | QueryConfig,
    b?: unknown[] | Callback<unknown>,
    c?: Callback<unknown>,
): { config: QueryConfig; values: unknown[]; callback: Callback<unknown> | undefined } {
    const config: QueryConfig = typeof a === "string" ? { text: a } : { ...a };
    let values: unknown[] | undefined;
    let callback: Callback<unknown> | undefined;
    if (typeof b === "function") callback = b;
    else {
        values = b;
        callback = c;
    }
    if (typeof config.values === "function") {
        callback = config.values as unknown as Callback<unknown>;
        config.values = undefined;
    }
    return { config, values: values ?? config.values ?? [], callback };
}

/**
 * A node-postgres compatible client: one SurrealDB session, over a WebSocket unless the
 * configuration pins HTTP. Values travel in the dialect's text form and are parsed with the
 * type parsers of `config.types`, as node-postgres does.
 */
export class Client extends Emitter {
    readonly config: ResolvedConfig;
    readonly processID: number = Math.floor(Math.random() * 2 ** 31);
    readonly secretKey = 0;
    readonly connection: { stream: { destroy(): void } };
    _queryable = false;
    _ending = false;
    _connected = false;
    #options: ClientConfig;
    #transport: Transport | undefined;
    #session: SqlSession | undefined;
    #connecting: Promise<void> | undefined;

    constructor(config?: string | ClientConfig) {
        super();
        const options: ClientConfig = typeof config === "string" ? { connectionString: config } : { ...config };
        this.#options = options;
        this.config = resolveConfig(toConnectOptions(options), "pg");
        this.connection = { stream: { destroy: () => void this.#transport?.close() } };
    }

    /** Whether a transaction is open on the session. */
    get inTransaction(): boolean {
        return (this.#session?.status ?? "idle") !== "idle";
    }

    connect(): Promise<void>;
    connect(callback: (error?: Error) => void): void;
    connect(callback?: (error?: Error) => void): Promise<void> | void {
        const promise = (this.#connecting ??= this.#open());
        if (!callback) return promise;
        promise.then(
            () => callback(),
            (error) => callback(error),
        );
    }

    async #open(): Promise<void> {
        if (this._ending) throw new Error("Client was closed and is not queryable");
        const transport: Transport =
            this.config.transport === "http" ? new HttpTransport(this.config) : new WsTransport(this.config);
        this.#transport = transport;
        this.#session = new SqlSession(transport, "pgsql", settingStatements(this.config.settings));
        transport.onEvent((event) => {
            if (event.type === "disconnected" && !this._ending) {
                this._queryable = false;
                this.#connecting = undefined;
                this.emit("error", event.error);
            }
        });
        await transport.open();
        this._queryable = true;
        this._connected = true;
        this.emit("connect");
    }

    query(config: string | QueryConfig, values?: unknown[]): Promise<QueryResult | QueryResult[]>;
    query(config: string | QueryConfig, callback: Callback<QueryResult | QueryResult[]>): void;
    query(config: string | QueryConfig, values: unknown[], callback: Callback<QueryResult | QueryResult[]>): void;
    query(
        a: string | QueryConfig,
        // biome-ignore lint/suspicious/noExplicitAny: the overloads above state the accepted forms
        b?: any,
        // biome-ignore lint/suspicious/noExplicitAny: the overloads above state the accepted forms
        c?: any,
    ): Promise<QueryResult | QueryResult[]> | void {
        const { config, values, callback } = normalizeQueryArgs(a, b, c);
        const promise = this.#query(config, values);
        if (!callback) return promise;
        promise.then(
            (result) => callback(null, result),
            (error) => callback(error),
        );
    }

    async #query(config: QueryConfig, values: unknown[]): Promise<QueryResult | QueryResult[]> {
        if (this._ending) throw new Error("Client was closed and is not queryable");
        if (!this.#session) await this.connect();
        const session = this.#session as SqlSession;
        const timeout = config.query_timeout ?? this.#options.query_timeout;
        const response = await session.run(
            config.text,
            buildVars(values),
            { rowMode: "array", valueMode: "text" },
            timeout ? { timeoutMs: timeout } : undefined,
        );
        const results = toQueryResults(response, config);
        return results.length === 1 ? results[0] : results.length === 0 ? emptyResult() : results;
    }

    end(): Promise<void>;
    end(callback: () => void): void;
    end(callback?: () => void): Promise<void> | void {
        this._ending = true;
        this._queryable = false;
        const done = (async () => {
            this.#session?.dispose();
            await this.#transport?.close();
            this.emit("end");
        })();
        if (!callback) return done;
        done.then(callback, callback);
    }
}

function emptyResult(): QueryResult {
    return { command: "", rowCount: null, oid: null, rows: [], fields: [] };
}
