import {
    buildVars,
    Emitter,
    HttpTransport,
    type ResolvedConfig,
    resolveConfig,
    SqlSession,
    StatementError,
    type Transport,
    type WireColumn,
    type WireResponse,
    WsTransport,
} from "@surrealdb/sql-internal";
import { type MysqlConnectOptions, settingStatements } from "../native";
import { decodeMysql, type MysqlDecodeOptions, TYPE_NAMES, typeName } from "../types";
import { MysqlError } from "./errors";
import { prepare } from "./prepare";

export interface FieldPacket {
    name: string;
    table: string;
    orgName: string;
    orgTable: string;
    schema: string;
    characterSet: number;
    columnLength: number;
    columnType: number;
    type: number;
    flags: number;
    decimals: number;
}

export interface ResultSetHeader {
    fieldCount: number;
    affectedRows: number;
    insertId: number;
    info: string;
    serverStatus: number;
    warningStatus: number;
    changedRows: number;
}

export interface TypeCastField {
    type: string;
    length: number;
    db: string;
    table: string;
    name: string;
    string(): string | null;
    buffer(): Uint8Array | null;
    geometry(): null;
}

export type TypeCast = (field: TypeCastField, next: () => unknown) => unknown;

export interface QueryOptions {
    sql: string;
    values?: unknown[];
    rowsAsArray?: boolean;
    typeCast?: boolean | TypeCast;
    dateStrings?: boolean | string[];
    timeout?: number;
    nestTables?: boolean | string;
}

export interface ConnectionConfig extends MysqlConnectOptions {
    uri?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl?: unknown;
    supportBigNumbers?: boolean;
    bigNumberStrings?: boolean;
    connectionLimit?: number;
    waitForConnections?: boolean;
    multipleStatements?: boolean;
    typeCast?: boolean | TypeCast;
    [key: string]: unknown;
}

type Rows =
    | Record<string, unknown>[]
    | unknown[][]
    | ResultSetHeader
    | (Record<string, unknown>[] | ResultSetHeader)[];
export type QueryReply = [Rows, FieldPacket[] | undefined];

export function toConnectOptions(config: ConnectionConfig): MysqlConnectOptions {
    const options: MysqlConnectOptions = { ...(config as MysqlConnectOptions) };
    if (!options.url) {
        if (config.uri) options.url = config.uri;
        else if (config.host) {
            const secure = config.ssl ? "+https" : config.port ? "+http" : "";
            const auth = config.user
                ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password ?? "")}@`
                : "";
            const port = config.port ? `:${config.port}` : "";
            if (secure) {
                options.url = `surrealdb${secure}://${auth}${config.host}${port}/`;
                if (config.database) options.database = config.database;
            } else options.url = `mysql://${auth}${config.host}${port}/${config.database ?? ""}`;
        }
    }
    return options;
}

function fieldOf(c: WireColumn): FieldPacket {
    const name = typeName(c);
    const code =
        c.type.mysql_type ??
        Number(Object.entries(TYPE_NAMES).find(([, n]) => n === name)?.[0] ?? 253);
    return {
        name: c.name,
        table: c.table ?? "",
        orgName: c.column ?? c.name,
        orgTable: c.table ?? "",
        schema: "",
        characterSet: 224,
        columnLength: 0,
        columnType: code,
        type: code,
        flags: c.nullable === false ? 1 : 0,
        decimals: 0,
    };
}

function headerOf(statement: WireResponse["statements"][number]): ResultSetHeader {
    const command = statement.command;
    const affected = command?.rows_affected ?? 0;
    const insert = command?.last_insert_id;
    return {
        fieldCount: 0,
        affectedRows: affected,
        insertId: insert === null || insert === undefined ? 0 : Number(insert),
        info: "",
        serverStatus: 2,
        warningStatus: command?.warnings ?? 0,
        changedRows: affected,
    };
}

function decodeRow(
    raw: unknown,
    columns: WireColumn[],
    opts: QueryOptions,
    decode: MysqlDecodeOptions,
    defaultCast: boolean | TypeCast | undefined,
): unknown[] {
    const cells = Array.isArray(raw)
        ? raw
        : columns.map((c) => (raw as Record<string, unknown>)[c.name]);
    const cast = opts.typeCast ?? defaultCast;
    return cells.map((cell, i) => {
        const column = columns[i];
        const next = () => decodeMysql(cell, column, decode);
        if (typeof cast === "function") {
            const field: TypeCastField = {
                type: typeName(column),
                length: 0,
                db: "",
                table: column.table ?? "",
                name: column.name,
                string: () => (cell === null || cell === undefined ? null : String(cell)),
                buffer: () =>
                    cell === null || cell === undefined
                        ? null
                        : new TextEncoder().encode(String(cell)),
                geometry: () => null,
            };
            return cast(field, next);
        }
        if (cast === false) return cell === null || cell === undefined ? null : String(cell);
        return next();
    });
}

function normalize(
    a: string | QueryOptions,
    b?: unknown[] | unknown,
): { options: QueryOptions; values: unknown[] | undefined } {
    const options: QueryOptions = typeof a === "string" ? { sql: a } : { ...a };
    const values = Array.isArray(b) ? b : b === undefined ? options.values : [b];
    return { options, values };
}

/**
 * A mysql2/promise compatible connection: one SurrealDB session, over a WebSocket unless the
 * configuration pins HTTP. Values travel in the dialect's text form and are decoded to the JS
 * types mysql2 returns, honouring `typeCast`.
 */
export class Connection extends Emitter {
    declare readonly config: ResolvedConfig;
    readonly threadId: number = Math.floor(Math.random() * 2 ** 31);
    #options: ConnectionConfig;
    #transport: Transport | undefined;
    #session: SqlSession | undefined;
    #connecting: Promise<void> | undefined;
    #ended = false;

    constructor(config: ConnectionConfig | string) {
        super();
        this.#options = typeof config === "string" ? { uri: config } : { ...config };
        Object.defineProperty(this, "config", {
            value: resolveConfig(toConnectOptions(this.#options), "mysql"),
            enumerable: false,
        });
    }

    get inTransaction(): boolean {
        return (this.#session?.status ?? "idle") !== "idle";
    }

    connect(): Promise<void> {
        this.#connecting ??= this.#open();
        return this.#connecting;
    }

    async #open(): Promise<void> {
        if (this.#ended)
            throw new Error("Can't add new command when connection is in closed state");
        const transport: Transport =
            this.config.transport === "http"
                ? new HttpTransport(this.config)
                : new WsTransport(this.config);
        this.#transport = transport;
        this.#session = new SqlSession(transport, "mysql", settingStatements(this.config.settings));
        transport.onEvent((event) => {
            if (event.type === "disconnected" && !this.#ended) {
                this.#connecting = undefined;
                this.emit("error", event.error);
            }
        });
        await transport.open();
        this.emit("connect");
    }

    async #run(a: string | QueryOptions, b: unknown, expand: boolean): Promise<QueryReply> {
        if (this.#ended)
            throw new Error("Can't add new command when connection is in closed state");
        if (!this.#session) await this.connect();
        const { options, values } = normalize(a, b);
        const { text, params } = prepare(options.sql, values, expand);
        const response = await (this.#session as SqlSession).run(
            text,
            buildVars(params),
            { rowMode: "array", valueMode: "text" },
            options.timeout ? { timeoutMs: options.timeout } : undefined,
        );
        const decode: MysqlDecodeOptions = {
            bigint: this.#options.bigNumberStrings ? "string" : "auto",
            dateStrings: options.dateStrings === true || this.#options.dateStrings === true,
            decimalNumbers: this.#options.decimalNumbers,
        };
        const replies: [unknown, FieldPacket[] | undefined][] = [];
        for (const statement of response.statements) {
            if (statement.status === "ERR") {
                throw MysqlError.from(
                    new StatementError(statement.error ?? { message: "error" }),
                    options.sql,
                );
            }
            const columns = statement.columns ?? [];
            if (columns.length === 0) {
                replies.push([headerOf(statement), undefined]);
                continue;
            }
            const rows = (statement.rows ?? []).map((raw) => {
                const values = decodeRow(raw, columns, options, decode, this.#options.typeCast);
                if (options.rowsAsArray) return values;
                const obj: Record<string, unknown> = {};
                columns.forEach((c, i) => {
                    obj[c.name] = values[i];
                });
                return obj;
            });
            replies.push([rows, columns.map(fieldOf)]);
        }
        if (replies.length === 1) return replies[0] as QueryReply;
        if (replies.length === 0) return [headerOf({ status: "OK" }), undefined];
        return [
            replies.map((r) => r[0]) as Rows,
            replies.map((r) => r[1]) as unknown as FieldPacket[],
        ];
    }

    query(sql: string | QueryOptions, values?: unknown): Promise<QueryReply> {
        return this.#run(sql, values, true);
    }

    execute(sql: string | QueryOptions, values?: unknown): Promise<QueryReply> {
        return this.#run(sql, values, false);
    }

    async beginTransaction(): Promise<void> {
        await this.query("START TRANSACTION");
    }
    async commit(): Promise<void> {
        await this.query("COMMIT");
    }
    async rollback(): Promise<void> {
        await this.query("ROLLBACK");
    }

    async ping(): Promise<void> {
        if (!this.#session) await this.connect();
        await (this.#session as SqlSession).run("");
    }

    async end(): Promise<void> {
        this.#ended = true;
        this.#session?.dispose();
        await this.#transport?.close();
        this.emit("end");
    }

    destroy(): void {
        void this.end();
    }
}

export interface PoolConnection extends Connection {
    release(): void;
}

export class Pool extends Emitter {
    readonly config: ConnectionConfig;
    #limit: number;
    #all = new Set<PoolConnection>();
    #idle: PoolConnection[] = [];
    #waiting: ((c: PoolConnection) => void)[] = [];
    #oneShot: Connection | undefined;
    #ended = false;

    constructor(config: ConnectionConfig | string) {
        super();
        this.config = typeof config === "string" ? { uri: config } : { ...config };
        this.#limit = this.config.connectionLimit ?? 10;
    }

    async getConnection(): Promise<PoolConnection> {
        if (this.#ended) throw new Error("Pool is closed.");
        const idle = this.#idle.pop();
        if (idle) {
            this.emit("acquire", idle);
            return idle;
        }
        if (this.#all.size < this.#limit) {
            const connection = new Connection(this.config) as PoolConnection;
            connection.release = () => void this.releaseConnection(connection);
            this.#all.add(connection);
            try {
                await connection.connect();
            } catch (error) {
                this.#all.delete(connection);
                throw error;
            }
            this.emit("connection", connection);
            this.emit("acquire", connection);
            return connection;
        }
        this.emit("enqueue");
        return new Promise((resolve) => this.#waiting.push(resolve));
    }

    async releaseConnection(connection: PoolConnection): Promise<void> {
        if (!this.#all.has(connection)) return;
        if (connection.inTransaction) {
            try {
                await connection.rollback();
            } catch {
                this.#all.delete(connection);
                await connection.end();
                return;
            }
        }
        this.emit("release", connection);
        const waiter = this.#waiting.shift();
        if (waiter) waiter(connection);
        else this.#idle.push(connection);
    }

    #stateless(): Connection | undefined {
        if (this.config.transport === "ws") return undefined;
        this.#oneShot ??= new Connection({ ...this.config, transport: "http" });
        return this.#oneShot;
    }

    async #on<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
        const http = this.#stateless();
        if (http) return fn(http);
        const connection = await this.getConnection();
        try {
            return await fn(connection);
        } finally {
            connection.release();
        }
    }

    query(sql: string | QueryOptions, values?: unknown): Promise<QueryReply> {
        return this.#on((c) => c.query(sql, values));
    }

    execute(sql: string | QueryOptions, values?: unknown): Promise<QueryReply> {
        return this.#on((c) => c.execute(sql, values));
    }

    async end(): Promise<void> {
        this.#ended = true;
        await Promise.all([...this.#all].map((c) => c.end()));
        this.#all.clear();
        this.#idle = [];
        await this.#oneShot?.end();
    }
}

/** Resolve once connected, as `mysql2/promise` does. */
export async function createConnection(config: ConnectionConfig | string): Promise<Connection> {
    const connection = new Connection(config);
    await connection.connect();
    return connection;
}

export function createPool(config: ConnectionConfig | string): Pool {
    return new Pool(config);
}
