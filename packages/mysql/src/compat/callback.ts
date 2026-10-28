import {
    Connection,
    type ConnectionConfig,
    type FieldPacket,
    Pool,
    type PoolConnection,
    type QueryOptions,
    type QueryReply,
} from "./connection";

type Callback<T> = (error: Error | null, ...results: T[]) => void;
type QueryCallback = (error: Error | null, result?: QueryReply[0], fields?: FieldPacket[]) => void;

function settle<T>(
    promise: Promise<T>,
    callback: ((error: Error | null, value?: T) => void) | undefined,
) {
    promise.then(
        (value) => callback?.(null, value),
        (error) => callback?.(error as Error),
    );
}

function split(
    sql: string | QueryOptions,
    a?: unknown,
    b?: QueryCallback,
): { sql: string | QueryOptions; values: unknown; callback: QueryCallback | undefined } {
    if (typeof a === "function") return { sql, values: undefined, callback: a as QueryCallback };
    return { sql, values: a, callback: b };
}

/** A callback-style connection, the shape kysely's MysqlDialect and mysql2's callback API use. */
export class CallbackConnection {
    readonly promiseConnection: Connection | PoolConnection;
    readonly config: ConnectionConfig;
    readonly threadId: number;
    #release: (() => void) | undefined;

    constructor(connection: Connection | PoolConnection, release?: () => void) {
        this.promiseConnection = connection;
        this.config = connection.config as unknown as ConnectionConfig;
        this.threadId = connection.threadId;
        this.#release = release;
    }

    #run(promise: Promise<QueryReply>, callback: QueryCallback | undefined) {
        promise.then(
            ([result, fields]) => callback?.(null, result, fields),
            (error) => callback?.(error as Error),
        );
    }

    query(sql: string | QueryOptions, a?: unknown, b?: QueryCallback) {
        const { values, callback } = split(sql, a, b);
        this.#run(this.promiseConnection.query(sql, values), callback);
        return {
            stream: () => {
                throw new Error("Streaming is not supported");
            },
        };
    }

    execute(sql: string | QueryOptions, a?: unknown, b?: QueryCallback) {
        const { values, callback } = split(sql, a, b);
        this.#run(this.promiseConnection.execute(sql, values), callback);
    }

    connect(callback?: (error: Error | null) => void) {
        settle(this.promiseConnection.connect(), (e) => callback?.(e));
    }
    beginTransaction(callback?: (error: Error | null) => void) {
        settle(this.promiseConnection.beginTransaction(), (e) => callback?.(e));
    }
    commit(callback?: (error: Error | null) => void) {
        settle(this.promiseConnection.commit(), (e) => callback?.(e));
    }
    rollback(callback?: (error: Error | null) => void) {
        settle(this.promiseConnection.rollback(), (e) => callback?.(e));
    }
    ping(callback?: (error: Error | null) => void) {
        settle(this.promiseConnection.ping(), (e) => callback?.(e));
    }
    end(callback?: (error: Error | null) => void) {
        settle(this.promiseConnection.end(), (e) => callback?.(e));
    }
    release() {
        this.#release?.();
    }
    destroy() {
        this.promiseConnection.destroy();
    }
    on(event: string, listener: (...args: unknown[]) => void) {
        this.promiseConnection.on(event, listener);
        return this;
    }
    promise(): Connection | PoolConnection {
        return this.promiseConnection;
    }
}

export class CallbackPool {
    readonly promisePool: Pool;

    constructor(config: ConnectionConfig | string) {
        this.promisePool = new Pool(config);
    }

    getConnection(callback: (error: Error | null, connection?: CallbackConnection) => void) {
        this.promisePool.getConnection().then(
            (connection) =>
                callback(null, new CallbackConnection(connection, () => connection.release())),
            (error) => callback(error as Error),
        );
    }

    query(sql: string | QueryOptions, a?: unknown, b?: QueryCallback) {
        const { values, callback } = split(sql, a, b);
        this.#run(this.promisePool.query(sql, values), callback);
    }

    execute(sql: string | QueryOptions, a?: unknown, b?: QueryCallback) {
        const { values, callback } = split(sql, a, b);
        this.#run(this.promisePool.execute(sql, values), callback);
    }

    #run(promise: Promise<QueryReply>, callback: QueryCallback | undefined) {
        promise.then(
            ([result, fields]) => callback?.(null, result, fields),
            (error) => callback?.(error as Error),
        );
    }

    end(callback?: (error: Error | null) => void) {
        settle(this.promisePool.end(), (e) => callback?.(e));
    }

    on(event: string, listener: (...args: unknown[]) => void) {
        this.promisePool.on(event, listener);
        return this;
    }

    promise(): Pool {
        return this.promisePool;
    }
}

export function createPool(config: ConnectionConfig | string): CallbackPool {
    return new CallbackPool(config);
}

export function createConnection(config: ConnectionConfig | string): CallbackConnection {
    return new CallbackConnection(new Connection(config));
}

export type { Callback };
