import {
    type Capabilities,
    type ClientCore,
    type ConnectOptions,
    type Queryable as CoreQueryable,
    type CoreQueryOptions,
    createClientCore,
    type DialectSpec,
    type LiveMessage,
    Raw,
    type ResolvedConfig,
    type Statement,
    type StatementError,
    type StatementLike,
    settingStatements,
    toStatementError,
    transactionOptions,
    type WireColumn,
    type WireResponse,
    type WireStatement,
    type WireType,
} from "@surrealdb/sql-internal";
import { type DecodeOptions, decodeNative } from "./decode";
import { oidByName } from "./oids";
import { RecordId } from "./record-id";

export type { Capabilities, LiveMessage };
export { settingStatements };

export interface PgConnectOptions extends ConnectOptions, DecodeOptions {}

export interface QueryOptions extends DecodeOptions, CoreQueryOptions {}

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
    /** For an atomic call: whether it committed. Entries of an uncommitted call were rolled back, whatever their status */
    committed?: boolean;
    /** For an entry of an atomic call that did not commit: the statement ran but its effects were rolled back */
    rolledBack?: boolean;
    /** Every statement of the call in order; this result is the last of them */
    results: Result<Row>[];
}

export interface BatchOptions extends QueryOptions {
    /** Run all statements in one transaction which commits only if all succeed (default true) */
    atomic?: boolean;
    /** The isolation level of the atomic transaction */
    isolation?:
        | "snapshot"
        | "read uncommitted"
        | "read committed"
        | "repeatable read"
        | "serializable";
    /** Run the atomic transaction read-only: a write in it fails */
    readOnly?: boolean;
    /** Throw on the first failed statement (default true) */
    throwOnError?: boolean;
}

export interface TransactionOptions extends QueryOptions {
    isolation?: "snapshot" | "read committed" | "repeatable read" | "serializable";
    readOnly?: boolean;
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
        const result = {
            rows: rows as Record<string, unknown>[],
            columns: (statement.columns ?? []).map(toColumn),
            command: statement.command?.tag ?? "",
            rowCount: statement.command?.rows_affected ?? rows.length,
            time: statement.time ?? "",
            transaction: response.transaction.status,
            ...(response.transaction.committed === undefined
                ? {}
                : { committed: response.transaction.committed }),
            ...(statement.rolled_back ? { rolledBack: true } : {}),
        };
        Object.defineProperty(result, "results", { value: results, enumerable: false });
        results.push(result as Result);
        out.push(result as Result);
    }
    return out;
}

const placeholder = (n: number) => `$${n}`;

export type Queryable = CoreQueryable<Result, QueryOptions>;

const spec: DialectSpec<Result, Column, QueryOptions> = {
    method: "pgsql",
    placeholder,
    settingStatements,
    beginStatement: "BEGIN",
    beginOptions: transactionOptions,
    results: (response, options) => buildResults(response, options),
    emptyResult: (transaction) => ({
        rows: [],
        columns: [],
        command: "",
        rowCount: 0,
        time: "",
        transaction,
        results: [],
    }),
    column: toColumn,
};

export interface SqlClient extends Queryable {
    /** Splice trusted text into a template */
    raw(text: string): Raw;
    /** Build a vector parameter */
    vector(values: ArrayLike<number>): number[];
    batch(
        statements: readonly (StatementLike | string | { text: string; params?: unknown[] })[],
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
    const defaults: QueryOptions = {
        bigint: options.bigint,
        recordIds: options.recordIds,
        vectors: options.vectors,
        parse: options.parse,
        cast: options.cast,
    };
    const core: ClientCore<Result, Column, QueryOptions> = createClientCore(
        options,
        spec,
        "pg",
        defaults,
        (value, name) =>
            value instanceof RecordId
                ? { text: `type::record($${name})`, value: value.toString() }
                : { text: `$${name}`, value },
    );

    const client = core.query as unknown as SqlClient;
    client.raw = (text) => new Raw(text);
    client.vector = (values) => Array.from(values);
    client.batch = (async (statements, batchOptions) =>
        core.batch(statements, batchOptions)) as SqlClient["batch"];
    client.begin = core.begin as SqlClient["begin"];
    client.surql = core.surql;
    client.live = core.live;
    client.describe = core.describe as SqlClient["describe"];
    client.capabilities = core.capabilities;
    client.withDatabase = (database, namespace) =>
        connect({ ...options, database, namespace: namespace ?? options.namespace });
    client.close = core.close;
    Object.defineProperty(client, "config", { value: core.config, enumerable: false });
    return client;
}
