import { type ConnectOptions, type ResolvedConfig, resolveConfig } from "./config";
import type { BatchEntry, SqlMethod, WireColumn, WireResponse } from "./contract";
import { buildVars } from "./encode";
import type { StatementError } from "./errors";
import { CapabilityDeniedError, RpcError, UnsupportedOnTransportError } from "./errors";
import { HttpTransport } from "./http";
import { SqlSession, toStatementError } from "./run";
import { Raw, render, Statement, type StatementLike } from "./statement";
import type { CallOptions, Transport } from "./transport";
import { WsTransport } from "./ws";

/** The options every dialect's queries share. Dialects extend it with their decoding options. */
export interface CoreQueryOptions {
    rowMode?: "object" | "array";
    signal?: AbortSignal;
    timeout?: number;
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

/** What differs between the dialects. */
export interface DialectSpec<Result, Column, Options extends CoreQueryOptions> {
    method: SqlMethod;
    placeholder(index: number): string;
    settingStatements(settings: Record<string, string | number | boolean>): string[];
    beginStatement(options: { isolation?: string; readOnly?: boolean }): string;
    /** Build the results of a response; a failed statement throws unless `throwOnError` is false */
    results(
        response: WireResponse,
        options: Options & { throwOnError?: boolean },
    ): (Result | StatementError)[];
    emptyResult(transaction: "idle" | "active" | "failed"): Result;
    column(wire: WireColumn): Column;
}

function callOptions(options?: CoreQueryOptions): CallOptions | undefined {
    if (!options?.signal && options?.timeout === undefined) return undefined;
    return { signal: options.signal, timeoutMs: options.timeout };
}

function wireOptions(options?: CoreQueryOptions & { atomic?: boolean }) {
    const out: { rowMode?: "array"; atomic?: boolean } = {};
    if (options?.rowMode === "array") out.rowMode = "array";
    if (options?.atomic) out.atomic = true;
    return out;
}

export interface Queryable<Result, Options> {
    <Row = Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...values: unknown[]
    ): Statement<Row[]>;
    query(text: string, params?: unknown[], options?: Options): Promise<Result>;
    execute(text: string, params?: unknown[], options?: Options): Promise<Result>;
}

export function makeQueryable<Result, Column, Options extends CoreQueryOptions>(
    spec: DialectSpec<Result, Column, Options>,
    getSession: () => Promise<SqlSession>,
    defaults: Options,
): Queryable<Result, Options> {
    const run = async (text: string, params: readonly unknown[], options?: Options) => {
        const merged = { ...defaults, ...options } as Options;
        const session = await getSession();
        const response = await session.run(
            text,
            buildVars(params),
            wireOptions(merged),
            callOptions(merged),
        );
        const built = spec.results(response, merged) as Result[];
        return built[built.length - 1] ?? spec.emptyResult(response.transaction.status);
    };

    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!Array.isArray(strings) || !("raw" in strings)) {
            throw new TypeError(
                "Use the tagged template form sql`...` or sql.query(text, params): calling sql(text, params) is not supported",
            );
        }
        return Statement.template<unknown[]>(strings, values, async (statement) => {
            const { text, params } = render(statement, spec.placeholder);
            const result = (await run(text, params)) as unknown as { rows: unknown[] };
            return result.rows;
        });
    }) as unknown as Queryable<Result, Options>;
    tag.query = (text, params = [], options) => run(text, params, options);
    tag.execute = tag.query;
    return tag;
}

export interface TransactionOptionsBase {
    isolation?: string;
    readOnly?: boolean;
}

export interface BatchOptionsBase {
    atomic?: boolean;
    throwOnError?: boolean;
}

export interface ClientCore<Result, Column, Options extends CoreQueryOptions> {
    config: ResolvedConfig;
    query: Queryable<Result, Options>;
    batch(
        statements: readonly (StatementLike | string | { text: string; params?: unknown[] })[],
        options?: Options & BatchOptionsBase,
    ): Promise<(Result | StatementError)[]>;
    begin<T>(
        fn: (tx: Queryable<Result, Options>) => Promise<T>,
        options?: Options & TransactionOptionsBase,
    ): Promise<T>;
    surql(strings: TemplateStringsArray, ...values: unknown[]): Statement<unknown[]>;
    live<T = unknown>(table: string, options?: { diff?: boolean }): AsyncIterable<LiveMessage<T>>;
    describe(text: string): Promise<{
        columns: Column[];
        params: { name?: string; oid?: number; mysql_type?: number }[];
    }>;
    capabilities(): Promise<Capabilities>;
    close(): Promise<void>;
}

/**
 * The dialect-neutral client: builds the transports and sessions, and implements the one-shot,
 * batch, interactive transaction, SurrealQL, live and introspection operations on top of them.
 * `bindValue` renders a value for SurrealQL text, returning the placeholder and the variable.
 */
export function createClientCore<Result, Column, Options extends CoreQueryOptions>(
    input: string | ConnectOptions,
    spec: DialectSpec<Result, Column, Options>,
    dialect: "pg" | "mysql",
    defaults: Options,
    bindSurql: (value: unknown, name: string) => { text: string; value: unknown },
): ClientCore<Result, Column, Options> {
    const config = resolveConfig(input, dialect);
    const settings = spec.settingStatements(config.settings);
    const http = config.transport === "ws" ? undefined : new HttpTransport(config);
    const ws = config.transport === "http" ? undefined : new WsTransport(config);
    const sessions = new Map<"http" | "ws", SqlSession>();

    const sessionOf = (kind: "http" | "ws"): SqlSession => {
        let session = sessions.get(kind);
        if (!session) {
            const transport = kind === "http" ? http : ws;
            if (!transport) {
                throw new UnsupportedOnTransportError(
                    `The ${kind} transport is not available: the client is pinned to ${config.transport}`,
                );
            }
            session = new SqlSession(transport, spec.method, settings);
            sessions.set(kind, session);
        }
        return session;
    };
    const oneShotKind = config.transport === "ws" ? "ws" : "http";
    const oneShot = async () => sessionOf(oneShotKind);
    const oneShotTransport = (oneShotKind === "ws" ? ws : http) as Transport;

    const query = makeQueryable(spec, oneShot, defaults);

    return {
        config,
        query,

        async batch(statements, batchOptions = {} as Options & BatchOptionsBase) {
            const entries: BatchEntry[] = statements.map((s) => {
                if (typeof s === "string") return { text: s };
                if ("source" in s) {
                    const { text, params } = render(s, spec.placeholder);
                    return { text, vars: buildVars(params) };
                }
                return { text: s.text, vars: buildVars(s.params ?? []) };
            });
            const merged = { ...defaults, ...batchOptions } as Options & BatchOptionsBase;
            const session = await oneShot();
            const response = await session.run(
                entries,
                undefined,
                wireOptions({ ...merged, atomic: batchOptions.atomic ?? true }),
                callOptions(merged),
            );
            return spec.results(response, merged);
        },

        async begin(fn, txOptions = {} as Options & TransactionOptionsBase) {
            if (config.transport === "http") {
                throw new UnsupportedOnTransportError(
                    "Interactive transactions need a WebSocket session; use batch() with atomic for HTTP",
                );
            }
            const transport = new WsTransport(config);
            const session = new SqlSession(transport, spec.method, settings);
            const merged = { ...defaults, ...txOptions } as Options;
            const tx = makeQueryable(spec, async () => session, merged);
            const check = (response: WireResponse) => {
                const failed = response.statements.find((s) => s.status === "ERR");
                if (failed) throw toStatementError(failed);
            };
            try {
                check(
                    await session.run(
                        spec.beginStatement(txOptions),
                        undefined,
                        undefined,
                        callOptions(merged),
                    ),
                );
                try {
                    const value = await fn(tx);
                    check(await session.run("COMMIT", undefined, undefined, callOptions(merged)));
                    return value;
                } catch (error) {
                    try {
                        await session.run("ROLLBACK");
                    } catch {
                        // The original error is the one that matters; a failed rollback must not mask it
                    }
                    throw error;
                }
            } finally {
                session.dispose();
                await transport.close();
            }
        },

        surql(strings, ...values) {
            if (!Array.isArray(strings) || !("raw" in strings)) {
                throw new TypeError("Use the tagged template form sql.surql`...`");
            }
            return Statement.template<unknown[]>(strings, values, async (statement) => {
                const vars: Record<string, unknown> = {};
                let n = 0;
                const text = renderSurql(statement, (value) => {
                    const name = `p${++n}`;
                    const bound = bindSurql(value, name);
                    vars[name] = bound.value;
                    return bound.text;
                });
                const replies = await oneShotTransport.call<{ status: string; result: unknown }[]>(
                    "query",
                    [text, vars],
                );
                const failed = replies.find((r) => r.status !== "OK");
                if (failed) throw new RpcError(String(failed.result), -32000, "Query");
                return replies.map((r) => r.result);
            });
        },

        live<T>(table: string, liveOptions: { diff?: boolean } = {}) {
            if (!ws)
                throw new UnsupportedOnTransportError("Live queries need a WebSocket connection");
            const transport = ws;
            return {
                async *[Symbol.asyncIterator]() {
                    const id = await transport.call<string>("live", [
                        table,
                        liveOptions.diff ?? false,
                    ]);
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
        },

        async describe(text) {
            const session = await oneShot();
            const response = await session.run(text, undefined, { describe: true });
            const first = response.statements[0];
            if (first?.status === "ERR") throw toStatementError(first);
            return {
                columns: (first?.columns ?? []).map(spec.column),
                params: (response.params ?? []).map((p) => p.type),
            };
        },

        async capabilities() {
            const transport = oneShotTransport;
            const caps = { interactiveTransactions: !!ws, live: !!ws };
            let version: string | undefined;
            try {
                version = String(await transport.call("version", []));
            } catch {
                version = undefined;
            }
            try {
                await transport.call(spec.method, [""]);
                return { supported: true, version, transport: caps };
            } catch (error) {
                if (error instanceof CapabilityDeniedError || error instanceof RpcError) {
                    return { supported: false, reason: error.message, version, transport: caps };
                }
                throw error;
            }
        },

        async close() {
            for (const s of sessions.values()) s.dispose();
            sessions.clear();
            await Promise.all([http?.close(), ws?.close()]);
        },
    };
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
