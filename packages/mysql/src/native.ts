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
    toStatementError,
    type WireColumn,
    type WireResponse,
    type WireType,
} from "@surrealdb/sql-internal";
import { decodeMysql, type MysqlDecodeOptions, typeName } from "./types";

export type { Capabilities, LiveMessage };

export interface MysqlConnectOptions extends ConnectOptions, MysqlDecodeOptions {}

export interface QueryOptions extends MysqlDecodeOptions, CoreQueryOptions {}

export interface Column {
    name: string;
    /** The protocol type name, for example `LONG` or `VAR_STRING` */
    typeName: string;
    mysqlType: number | undefined;
    nullable: boolean | null;
    table: string | null;
    column: string | null;
}

export interface Result<Row = Record<string, unknown>> {
    rows: Row[];
    columns: Column[];
    /** The statement kind, for example `SELECT` or `INSERT` */
    command: string;
    /** Rows read, or rows affected by a write */
    rowCount: number;
    insertId: number | string | null;
    warnings: number;
    time: string;
    transaction: "idle" | "active" | "failed";
    results: Result<Row>[];
}

export interface BatchOptions extends QueryOptions {
    atomic?: boolean;
    throwOnError?: boolean;
}

export interface TransactionOptions extends QueryOptions {
    isolation?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
    readOnly?: boolean;
}

function quote(value: string | number | boolean): string {
    return `'${String(value).replaceAll("'", "''")}'`;
}

export function settingStatements(settings: Record<string, string | number | boolean>): string[] {
    return Object.entries(settings).map(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name))
            throw new TypeError(`Invalid setting name "${name}"`);
        return `SET ${name} = ${quote(value)}`;
    });
}

export function toColumn(c: WireColumn): Column {
    return {
        name: c.name,
        typeName: typeName(c),
        mysqlType: c.type.mysql_type,
        nullable: c.nullable,
        table: c.table,
        column: c.column,
    };
}

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
        const columns = statement.columns ?? [];
        const rows = (statement.rows ?? []).map((raw) => {
            const cells = Array.isArray(raw)
                ? raw
                : columns.map((c) => (raw as Record<string, unknown>)[c.name]);
            const values = cells.map((cell, i) => decodeMysql(cell, columns[i], options));
            return rowMode === "array"
                ? values
                : Object.fromEntries(columns.map((c, i) => [c.name, values[i]]));
        });
        const command = statement.command;
        const result: Result = {
            rows: rows as Record<string, unknown>[],
            columns: columns.map(toColumn),
            command: command?.tag ?? "",
            rowCount: command?.rows_affected ?? rows.length,
            insertId: command?.last_insert_id ?? null,
            warnings: command?.warnings ?? 0,
            time: statement.time ?? "",
            transaction: response.transaction.status,
            results,
        };
        results.push(result);
        out.push(result);
    }
    return out;
}

export type Queryable = CoreQueryable<Result, QueryOptions>;

export const spec: DialectSpec<Result, Column, QueryOptions> = {
    method: "mysql",
    placeholder: () => "?",
    settingStatements,
    beginStatement: ({ isolation, readOnly }) => {
        const start = `START TRANSACTION${readOnly ? " READ ONLY" : ""}`;
        return isolation
            ? `SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}; ${start}`
            : start;
    },
    results: (response, options) => buildResults(response, options),
    emptyResult: (transaction) => ({
        rows: [],
        columns: [],
        command: "",
        rowCount: 0,
        insertId: null,
        warnings: 0,
        time: "",
        transaction,
        results: [],
    }),
    column: toColumn,
};

export interface SqlClient extends Queryable {
    raw(text: string): Raw;
    batch(
        statements: readonly (StatementLike | string | { text: string; params?: unknown[] })[],
        options?: BatchOptions,
    ): Promise<Result[]>;
    begin<T>(fn: (tx: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T>;
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
 * const sql = connect("mysql://root:root@abc.surrealdb.earth/app?namespace=prod");
 * const rows = await sql`SELECT * FROM person WHERE name = ${name}`;
 * ```
 */
export function connect(input: string | MysqlConnectOptions): SqlClient {
    const options: MysqlConnectOptions = typeof input === "string" ? { url: input } : input;
    const defaults: QueryOptions = {
        bigint: options.bigint,
        dateStrings: options.dateStrings,
        decimalNumbers: options.decimalNumbers,
        cast: options.cast,
    };
    const core: ClientCore<Result, Column, QueryOptions> = createClientCore(
        options,
        spec,
        "mysql",
        defaults,
        (value, name) => ({ text: `$${name}`, value }),
    );
    const client = core.query as unknown as SqlClient;
    client.raw = (text) => new Raw(text);
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
    Object.defineProperty(client, "config", { value: core.config, enumerable: true });
    return client;
}
