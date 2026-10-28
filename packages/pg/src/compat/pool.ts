import { Emitter } from "@surrealdb/sql-internal";
import { Client, type ClientConfig, type QueryConfig, type QueryResult, normalizeQueryArgs } from "./client";

export interface PoolConfig extends ClientConfig {
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    /** The client class to build, as in pg-pool */
    Client?: new (config?: ClientConfig) => Client;
    /** Run `pool.query()` calls over HTTP when the configuration allows it (default true) */
    poolQueryViaHttp?: boolean;
}

export interface PoolClient extends Client {
    release(error?: Error | boolean): void;
}

type Callback<T> = (error: Error | null, result?: T) => void;

interface Idle {
    client: PoolClient;
    timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * A node-postgres compatible pool. Pooled clients are WebSocket sessions; `release()` rolls
 * back an open transaction before a client is reused, and drops a client released with an error.
 * `pool.query()` runs over stateless HTTP when the transport is `auto`.
 */
export class Pool extends Emitter {
    readonly options: PoolConfig;
    ending = false;
    ended = false;
    #clients = new Set<PoolClient>();
    #idle: Idle[] = [];
    #waiting: { resolve(client: PoolClient): void; reject(error: Error): void }[] = [];
    #oneShot: Client | undefined;

    constructor(options: PoolConfig = {}) {
        super();
        this.options = { max: 10, idleTimeoutMillis: 10000, ...options };
    }

    get totalCount(): number {
        return this.#clients.size;
    }
    get idleCount(): number {
        return this.#idle.length;
    }
    get waitingCount(): number {
        return this.#waiting.length;
    }

    connect(): Promise<PoolClient>;
    connect(callback: (error: Error | undefined, client?: PoolClient, done?: (e?: Error | boolean) => void) => void): void;
    connect(callback?: (error: Error | undefined, client?: PoolClient, done?: (e?: Error | boolean) => void) => void): Promise<PoolClient> | void {
        const promise = this.#acquire();
        if (!callback) return promise;
        promise.then(
            (client) => callback(undefined, client, (e) => client.release(e)),
            (error) => callback(error),
        );
    }

    async #acquire(): Promise<PoolClient> {
        if (this.ending) throw new Error("Cannot use a pool after calling end on the pool");
        const idle = this.#idle.pop();
        if (idle) {
            if (idle.timer) clearTimeout(idle.timer);
            this.emit("acquire", idle.client);
            return idle.client;
        }
        if (this.#clients.size < (this.options.max ?? 10)) return this.#create();
        return new Promise<PoolClient>((resolve, reject) => {
            this.#waiting.push({ resolve, reject });
        });
    }

    async #create(): Promise<PoolClient> {
        const ClientClass = this.options.Client ?? Client;
        const client = new ClientClass(this.options) as PoolClient;
        this.#clients.add(client);
        client.release = (error) => void this.#release(client, error);
        client.on("error", (e: unknown) => {
            this.#remove(client);
            if (this.listenerCount("error") > 0) this.emit("error", e, client);
        });
        try {
            await client.connect();
        } catch (error) {
            this.#remove(client);
            throw error;
        }
        this.emit("connect", client);
        this.emit("acquire", client);
        return client;
    }

    async #release(client: PoolClient, error?: Error | boolean): Promise<void> {
        if (!this.#clients.has(client)) return;
        let broken = !!error || this.ending || !client._queryable;
        if (!broken && client.inTransaction) {
            try {
                await client.query("ROLLBACK");
            } catch {
                broken = true;
            }
        }
        if (broken) {
            this.#remove(client);
            await client.end();
            this.#serveWaiting();
            return;
        }
        const waiter = this.#waiting.shift();
        if (waiter) {
            this.emit("release", undefined, client);
            waiter.resolve(client);
            return;
        }
        const timeout = this.options.idleTimeoutMillis;
        const entry: Idle = { client, timer: undefined };
        if (timeout && timeout > 0) {
            entry.timer = setTimeout(() => {
                this.#idle = this.#idle.filter((i) => i !== entry);
                this.#remove(client);
                void client.end();
            }, timeout);
            (entry.timer as { unref?: () => void }).unref?.();
        }
        this.#idle.push(entry);
        this.emit("release", undefined, client);
    }

    #remove(client: PoolClient): void {
        this.#clients.delete(client);
        this.#idle = this.#idle.filter((i) => i.client !== client);
        this.emit("remove", client);
    }

    #serveWaiting(): void {
        const waiter = this.#waiting.shift();
        if (waiter) this.#create().then(waiter.resolve, waiter.reject);
    }

    #httpClient(): Client | undefined {
        if (this.options.poolQueryViaHttp === false) return undefined;
        if (this.options.transport === "ws") return undefined;
        this.#oneShot ??= new Client({ ...this.options, transport: "http" });
        return this.#oneShot;
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
        const run = async () => {
            const http = this.#httpClient();
            if (http) return (await http.query(config, values)) as QueryResult | QueryResult[];
            const client = await this.#acquire();
            try {
                return (await client.query(config, values)) as QueryResult | QueryResult[];
            } finally {
                client.release();
            }
        };
        const promise = run();
        if (!callback) return promise;
        promise.then(
            (result) => callback(null, result),
            (error) => callback(error),
        );
    }

    end(): Promise<void>;
    end(callback: () => void): void;
    end(callback?: () => void): Promise<void> | void {
        this.ending = true;
        const done = (async () => {
            for (const waiter of this.#waiting.splice(0)) waiter.reject(new Error("Pool is ending"));
            for (const idle of this.#idle) if (idle.timer) clearTimeout(idle.timer);
            this.#idle = [];
            await Promise.all([...this.#clients].map((c) => c.end()));
            this.#clients.clear();
            await this.#oneShot?.end();
            this.ended = true;
        })();
        if (!callback) return done;
        done.then(callback, callback);
    }
}
