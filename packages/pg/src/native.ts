import {
    type BatchEntry,
    buildVars,
    type CallOptions,
    CapabilityDeniedError,
    type ConnectOptions,
    createTransports,
    HttpTransport,
    Raw,
    type ResolvedConfig,
    RpcError,
    render,
    resolveConfig,
    SqlSession,
    Statement,
    type StatementError,
    type StatementLike,
    type Transport,
    toStatementError,
    UnsupportedOnTransportError,
    type WireColumn,
    type WireResponse,
    type WireStatement,
    type WireType,
    WsTransport,
} from "@surrealdb/sql-internal";
import { type DecodeOptions, decodeNative } from "./decode";
import { oidByName } from "./oids";
import { RecordId } from "./record-id";

export interface PgConnectOptions extends ConnectOptions, DecodeOptions {}

export interface QueryOptions extends DecodeOptions {
    /** Rows as objects keyed by column name (default) or as arrays in column order */
    rowMode?: "object" | "array";
    signal?: AbortSignal;
    /** Milliseconds; overrides the client default */
    timeout?: number;
}

export interface Column {
    name: string;
    /** The wire type name, for example `int4` or `timestamptz` */
    typeName: string;
    oid: number | undefined;
    type: WireType;
    nullable: boolean | null;
    table: string | null;
    column: string | null;
}

export interface Result<Row = Record<string, unknown>> {
    rows: Row[];
    columns: Column[];
    /** The command tag, for example `SELECT 3` or `INSERT 0 1` */
    command: string;
    rowCount: number;
    /** Server time for the statement, as the instance reports it */
    time: string;
    transaction: "idle" | "active" | "failed";
    /** Every statement of the call in order; this result is the last of them */
    results: Result<Row>[];
}

export interface BatchOptions extends QueryOptions {
    /** Run all statements in one transaction which commits only if all succeed (default true) */
    atomic?: boolean;
    /** Throw on the first failed statement (default true) */
    throwOnError?: boolean;
}

export interface TransactionOptions extends QueryOptions {
    isolation?: "read committed" | "repeatable read" | "serializable";
    readOnly?: boolean;
}

export interface LiveMessage<T = unknown> {
    action: "CREATE" | "UPDATE" | "DELETE" | "KILLED";
    id: string;
    result: T;
}

export interface Capabilities {
    supported: boolean;
    reason?: string;
    version?: string;
    transport: { interactiveTransactions: boolean; live: boolean };
}

function quoteSetting(value: string | number | boolean): string {
    return `'${String(value).replaceAll("'", "''")}'`;
}

/** `SET` statements for the `settings` option. */
export function settingStatements(settings: Record<string, string | number | boolean>): string[] {
    return Object.entries(settings).map(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
            throw new TypeError(`Invalid setting name "${name}"`);
        }
        return `SET ${name} = ${quoteSetting(value)}`;
    });
}

export function toColumn(c: WireColumn): Column {
    const typeName = c.type.name ?? "unknown";
    return {
        name: c.name,
        typeName,
        oid: c.type.oid ?? oidByName[typeName],
        type: c.type,
        nullable: c.nullable,
        table: c.table,
        column: c.column,
    };
}

function decodeRows(
    statement: WireStatement,
    rowMode: "object" | "array",
    decode: DecodeOptions,
): unknown[] {
    const columns = statement.columns ?? [];
    const rows = statement.rows ?? [];
    return rows.map((row) => {
        if (Array.isArray(row)) {
            const values = columns.map((c, i) => decodeNative(row[i], c, decode));
            return rowMode === "array"
                ? values
                : Object.fromEntries(columns.map((c, i) => [c.name, values[i]]));
        }
        const record = row as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const c of columns) out[c.name] = decodeNative(record[c.name], c, decode);
        return rowMode === "array" ? columns.map((c) => out[c.name]) : out;
    });
}

/** Build the results of a response. A failed statement throws unless `throwOnError` is false. */
export function buildResults(
    response: WireResponse,
    options: QueryOptions & { throwOnError?: boolean } = {},
): (Result | StatementError)[] {
    const rowMode = options.rowMode ?? "object";
    const out: (Result | StatementError)[] = [];
    const results: Result[] = [];
    for (const statement of response.statements) {
        if (statement.status === "ERR") {
            const error = toStatementError(statement);
            error.results = results;
            if (options.throwOnError !== false) throw error;
            out.push(error);
            continue;
        }
        const rows = decodeRows(statement, rowMode, options);
        const result: Result = {
            rows: rows as Record<string, unknown>[],
            columns: (statement.columns ?? []).map(toColumn),
            command: statement.command?.tag ?? "",
            rowCount: statement.command?.rows_affected ?? rows.length,
            time: statement.time ?? "",
            transaction: response.transaction.status,
            results,
        };
        results.push(result);
        out.push(result);
    }
    return out;
}

function callOptions(options?: QueryOptions): CallOptions | undefined {
    if (!options?.signal && options?.timeout === undefined) return undefined;
    return { signal: options.signal, timeoutMs: options.timeout };
}

function wireOptions(options?: QueryOptions & { atomic?: boolean }) {
    const out: { rowMode?: "array"; atomic?: boolean } = {};
    if (options?.rowMode === "array") out.rowMode = "array";
    if (options?.atomic) out.atomic = true;
    return out;
}

const placeholder = (n: number) => `$${n}`;

/** Queries which run on one session: the one-shot session or a dedicated transaction one. */
export interface Queryable {
    <Row = Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...values: unknown[]
    ): Statement<Row[]>;
    query<Row = Record<string, unknown>>(
        text: string,
        params?: unknown[],
        options?: QueryOptions,
    ): Promise<Result<Row>>;
    execute<Row = Record<string, unknown>>(
        text: string,
        params?: unknown[],
        options?: QueryOptions,
    ): Promise<Result<Row>>;
}

function makeQueryable(getSession: () => Promise<SqlSession>, defaults: QueryOptions): Queryable {
    const run = async (text: string, params: readonly unknown[], options?: QueryOptions) => {
        const merged = { ...defaults, ...options };
        const session = await getSession();
        const response = await session.run(
            text,
            buildVars(params),
            wireOptions(merged),
            callOptions(merged),
        );
        const built = buildResults(response, merged) as Result[];
        const last = built[built.length - 1];
        if (!last) {
            return {
                rows: [],
                columns: [],
                command: "",
                rowCount: 0,
                time: "",
                transaction: response.transaction.status,
                results: [],
            } satisfies Result;
        }
        return last;
    };

    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!Array.isArray(strings) || !("raw" in strings)) {
            throw new TypeError(
                "Use the tagged template form sql`...` or sql.query(text, params): calling sql(text, params) is not supported",
            );
        }
        return Statement.template<Record<string, unknown>[]>(strings, values, async (statement) => {
            const { text, params } = render(statement, placeholder);
            return (await run(text, params)).rows;
        });
    }) as Queryable;
    tag.query = (text, params = [], options) => run(text, params, options) as never;
    tag.execute = tag.query;
    return tag;
}

export interface SqlClient extends Queryable {
    /** Splice trusted text into a template */
    raw(text: string): Raw;
    /** Build a vector parameter */
    vector(values: ArrayLike<number>): number[];
    batch(
        statements: readonly (Statement<unknown> | string | { text: string; params?: unknown[] })[],
        options?: BatchOptions,
    ): Promise<Result[]>;
    begin<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
    /** SurrealQL on the same connection, namespace, database and auth */
    surql(strings: TemplateStringsArray, ...values: unknown[]): Statement<unknown[]>;
    live<T = unknown>(table: string, options?: { diff?: boolean }): AsyncIterable<LiveMessage<T>>;
    describe(text: string): Promise<{ columns: Column[]; params: WireType[] }>;
    capabilities(): Promise<Capabilities>;
    withDatabase(database: string, namespace?: string): SqlClient;
    close(): Promise<void>;
    readonly config: ResolvedConfig;
}

/**
 * Connect to an instance. Nothing is sent until the first query.
 *
 * ```ts
 * const sql = connect("postgres://root:root@abc.surrealdb.earth/app?namespace=prod");
 * const rows = await sql`SELECT * FROM person WHERE name = ${name}`;
 * ```
 */
export function connect(input: string | PgConnectOptions): SqlClient {
    const options: PgConnectOptions = typeof input === "string" ? { url: input } : input;
    const config = resolveConfig(options, "pg");
    const settings = settingStatements(config.settings);
    const transports = createTransports(config);
    const sessions = new Map<"http" | "ws", SqlSession>();
    const decode: DecodeOptions = {
        bigint: options.bigint,
        recordIds: options.recordIds,
        vectors: options.vectors,
        parse: options.parse,
        cast: options.cast,
    };
    const defaults: QueryOptions = { ...decode };

    const sessionOf = (kind: "http" | "ws"): SqlSession => {
        let session = sessions.get(kind);
        if (!session) {
            const transport = transports[kind];
            if (!transport) {
                throw new UnsupportedOnTransportError(
                    `The ${kind} transport is not available: the client is pinned to ${config.transport}`,
                );
            }
            session = new SqlSession(transport, "pgsql", settings);
            sessions.set(kind, session);
        }
        return session;
    };
    const oneShotKind = config.transport === "ws" ? "ws" : "http";
    const oneShot = async () => sessionOf(oneShotKind);

    const client = makeQueryable(oneShot, defaults) as SqlClient;

    client.raw = (text) => new Raw(text);
    client.vector = (values) => Array.from(values);

    client.batch = async (statements, batchOptions = {}) => {
        const entries: BatchEntry[] = statements.map((s) => {
            if (s instanceof Statement) {
                const { text, params } = render(s, placeholder);
                return { text, vars: buildVars(params) };
            }
            if (typeof s === "string") return { text: s };
            return { text: s.text, vars: buildVars(s.params ?? []) };
        });
        const merged = { ...defaults, ...batchOptions };
        const session = await oneShot();
        const response = await session.run(
            entries,
            undefined,
            wireOptions({ ...merged, atomic: batchOptions.atomic ?? true }),
            callOptions(merged),
        );
        const built = buildResults(response, merged);
        return built as Result[];
    };

    client.begin = async (fn, txOptions = {}) => {
        if (config.transport === "http") {
            throw new UnsupportedOnTransportError(
                "Interactive transactions need a WebSocket session; use batch() with atomic for HTTP",
            );
        }
        const transport = new WsTransport(config);
        const session = new SqlSession(transport, "pgsql", settings);
        const merged = { ...defaults, ...txOptions };
        const tx = makeQueryable(async () => session, merged);
        const modes: string[] = [];
        if (txOptions.isolation) modes.push(`ISOLATION LEVEL ${txOptions.isolation.toUpperCase()}`);
        if (txOptions.readOnly) modes.push("READ ONLY");
        try {
            const begin = await session.run(
                `BEGIN ${modes.join(" ")}`.trim(),
                undefined,
                undefined,
                callOptions(merged),
            );
            buildResults(begin, {});
            try {
                const value = await fn(tx);
                buildResults(
                    await session.run("COMMIT", undefined, undefined, callOptions(merged)),
                    {},
                );
                return value;
            } catch (error) {
                try {
                    await session.run("ROLLBACK", undefined, undefined, undefined);
                } catch {
                    // The original error is the one that matters; a failed rollback must not mask it
                }
                throw error;
            }
        } finally {
            session.dispose();
            await transport.close();
        }
    };

    client.surql = (strings, ...values) => {
        if (!Array.isArray(strings) || !("raw" in strings)) {
            throw new TypeError("Use the tagged template form sql.surql`...`");
        }
        return Statement.template<unknown[]>(strings, values, async (statement) => {
            const vars: Record<string, unknown> = {};
            let n = 0;
            const text = renderSurql(statement, (value) => {
                const name = `p${++n}`;
                vars[name] = value instanceof RecordId ? value.toString() : value;
                return value instanceof RecordId ? `type::record($${name})` : `$${name}`;
            });
            const transport = transports[oneShotKind] as Transport;
            const replies = await transport.call<{ status: string; result: unknown }[]>("query", [
                text,
                vars,
            ]);
            const failed = replies.find((r) => r.status !== "OK");
            if (failed) throw new RpcError(String(failed.result), -32000, "Query");
            return replies.map((r) => r.result);
        });
    };

    client.live = <T>(table: string, liveOptions: { diff?: boolean } = {}) => {
        if (config.transport === "http" || !transports.ws) {
            throw new UnsupportedOnTransportError("Live queries need a WebSocket connection");
        }
        const transport = transports.ws;
        return {
            async *[Symbol.asyncIterator]() {
                const id = await transport.call<string>("live", [table, liveOptions.diff ?? false]);
                const queue: LiveMessage<T>[] = [];
                let wake: (() => void) | undefined;
                let lost: unknown;
                const off = transport.onEvent((event) => {
                    if (event.type === "live") {
                        const m = event.message as LiveMessage<T>;
                        if (String(m.id) === String(id)) {
                            queue.push(m);
                            wake?.();
                        }
                    } else if (event.type === "disconnected") {
                        lost = event.error;
                        wake?.();
                    }
                });
                try {
                    for (;;) {
                        const next = queue.shift();
                        if (next) {
                            yield next;
                            continue;
                        }
                        if (lost) throw lost;
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                        wake = undefined;
                    }
                } finally {
                    off();
                    try {
                        await transport.call("kill", [id]);
                    } catch {
                        // The connection may already be gone, which also ends the live query
                    }
                }
            },
        };
    };

    client.describe = async (text) => {
        const session = await oneShot();
        const response = await session.run(text, undefined, { describe: true });
        const first = response.statements[0];
        if (first?.status === "ERR") throw toStatementError(first);
        return {
            columns: (first?.columns ?? []).map(toColumn),
            params: (response.params ?? []).map((p) => p.type),
        };
    };

    client.capabilities = async () => {
        const kind = oneShotKind;
        const transport = transports[kind] as Transport;
        const caps = {
            interactiveTransactions: config.transport !== "http" && !!transports.ws,
            live: config.transport !== "http" && !!transports.ws,
        };
        let version: string | undefined;
        try {
            version = String(await transport.call("version", []));
        } catch {
            version = undefined;
        }
        try {
            await transport.call("pgsql", [""]);
            return { supported: true, version, transport: caps };
        } catch (error) {
            if (error instanceof CapabilityDeniedError || error instanceof RpcError) {
                return { supported: false, reason: error.message, version, transport: caps };
            }
            throw error;
        }
    };

    client.withDatabase = (database, namespace) =>
        connect({
            ...options,
            database,
            namespace: namespace ?? options.namespace,
            url: options.url,
        });

    client.close = async () => {
        for (const s of sessions.values()) s.dispose();
        sessions.clear();
        await Promise.all([transports.http?.close(), transports.ws?.close()]);
    };

    Object.defineProperty(client, "config", { value: config, enumerable: true });
    return client;
}

function renderSurql(statement: StatementLike, bind: (value: unknown) => string): string {
    const source = statement.source;
    if (source.kind === "direct") return source.text;
    let text = source.strings[0] ?? "";
    source.values.forEach((value, i) => {
        if (value instanceof Raw) text += value.text;
        else if (value instanceof Statement) text += renderSurql(value, bind);
        else text += bind(value);
        text += source.strings[i + 1] ?? "";
    });
    return text;
}

export { HttpTransport };
