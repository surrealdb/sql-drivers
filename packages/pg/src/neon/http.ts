import {
    buildVars,
    type ConnectOptions,
    HttpTransport,
    resolveConfig,
    SqlSession,
    toStatementError,
    type WireResponse,
} from "@surrealdb/sql-internal";
import { type FieldDef, type TypesLike, toQueryResults } from "../compat/client";
import { neonConfig } from "./config";
import { NeonDbError } from "./errors";

export type QueryRows<ArrayMode extends boolean> = ArrayMode extends true
    ? any[][]
    : Record<string, any>[];

/** The node-postgres shaped result returned when `fullResults` is set. */
export interface FullQueryResults<ArrayMode extends boolean> {
    fields: FieldDef[];
    command: string;
    rowCount: number | null;
    rows: QueryRows<ArrayMode>;
    rowAsArray: ArrayMode;
    viaNeonFetch: true;
}

export type AuthToken = string | (() => string | Promise<string>);

export interface HTTPQueryOptions<ArrayMode extends boolean, FullResults extends boolean> {
    /** Rows as arrays of values instead of objects */
    arrayMode?: ArrayMode;
    /** Return `{ fields, command, rowCount, rows, ... }` instead of the rows */
    fullResults?: FullResults;
    /** Extra `fetch` options for the request, such as `cache` or `signal` */
    fetchOptions?: Record<string, any>;
    /** Type parsers by OID, in the shape of `pg.types` */
    types?: TypesLike;
    /** A bearer token presented for this call in place of the connection string's credentials */
    authToken?: AuthToken;
}

export type NeonIsolationLevel =
    | "ReadUncommitted"
    | "ReadCommitted"
    | "RepeatableRead"
    | "Serializable";

export interface HTTPTransactionOptions<ArrayMode extends boolean, FullResults extends boolean>
    extends HTTPQueryOptions<ArrayMode, FullResults> {
    isolationLevel?: NeonIsolationLevel;
    readOnly?: boolean;
    deferrable?: boolean;
}

export interface NeonOptions<ArrayMode extends boolean, FullResults extends boolean>
    extends HTTPTransactionOptions<ArrayMode, FullResults> {
    /** The `fetch` to use for this function, ahead of `neonConfig.fetchFunction` */
    fetchFunction?: typeof fetch;
}

type ResultOf<A extends boolean, F extends boolean> = F extends true
    ? FullQueryResults<A>
    : QueryRows<A>;

interface Parameterized {
    query: string;
    params: unknown[];
}

/**
 * A query which has not been sent. It is a thenable: it is sent when awaited, once, and a
 * transaction collects the queries it is given without sending them.
 */
export class NeonQueryPromise<
    ArrayMode extends boolean = false,
    FullResults extends boolean = false,
    T = ResultOf<ArrayMode, FullResults>,
> implements PromiseLike<T>
{
    #run: (query: NeonQueryPromise<any, any, any>) => Promise<T>;
    #promise: Promise<T> | undefined;

    constructor(
        readonly parameterizedQuery: Parameterized,
        readonly opts: HTTPQueryOptions<ArrayMode, FullResults> | undefined,
        run: (query: NeonQueryPromise<any, any, any>) => Promise<T>,
    ) {
        this.#run = run;
    }

    then<R1 = T, R2 = never>(
        onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
        onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
        this.#promise ??= this.#run(this);
        return this.#promise.then(onfulfilled, onrejected);
    }

    catch<R = never>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<T | R> {
        return this.then(undefined, onrejected);
    }

    finally(onfinally?: (() => void) | null): Promise<T> {
        return this.then(
            (value) => {
                onfinally?.();
                return value;
            },
            (error) => {
                onfinally?.();
                throw error;
            },
        );
    }
}

/** Text spliced into a template verbatim, built by `sql.unsafe`. */
export class UnsafeRawSql {
    constructor(readonly sql: string) {}
}

export interface NeonQueryInTransaction {
    (strings: TemplateStringsArray, ...params: any[]): NeonQueryPromise<boolean, boolean>;
    query(
        queryWithPlaceholders: string,
        params?: any[],
        opts?: HTTPQueryOptions<boolean, boolean>,
    ): NeonQueryPromise<boolean, boolean>;
    unsafe(rawSQL: string): UnsafeRawSql;
}

export interface NeonQueryFunction<ArrayMode extends boolean, FullResults extends boolean> {
    (strings: TemplateStringsArray, ...params: any[]): NeonQueryPromise<ArrayMode, FullResults>;
    query<A extends boolean = ArrayMode, F extends boolean = FullResults>(
        queryWithPlaceholders: string,
        params?: any[],
        opts?: HTTPQueryOptions<A, F>,
    ): NeonQueryPromise<A, F>;
    unsafe(rawSQL: string): UnsafeRawSql;
    /**
     * Run queries as one atomic call: they all commit or none does. Pass the queries, or a
     * function from a query builder to the queries.
     */
    transaction<A extends boolean = ArrayMode, F extends boolean = FullResults>(
        queries:
            | NeonQueryPromise<any, any, any>[]
            | ((sql: NeonQueryInTransaction) => NeonQueryPromise<any, any, any>[]),
        opts?: HTTPTransactionOptions<A, F>,
    ): Promise<ResultOf<A, F>[]>;
}

const TEMPLATE_MISUSE =
    "This function is called as a tagged template only. For text with numbered placeholders, use sql.query(text, params, options).";

const ISOLATION_LEVELS = new Set(["ReadUncommitted", "ReadCommitted", "RepeatableRead"]);

function envConnectionString(): string | undefined {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
        ?.env;
    return env?.DATABASE_URL;
}

function checkTransactionOptions(opts: HTTPTransactionOptions<boolean, boolean>): void {
    const level = opts.isolationLevel;
    if (level !== undefined && level !== "Serializable" && !ISOLATION_LEVELS.has(level)) {
        throw new TypeError(`Unknown isolation level "${level}"`);
    }
}

/** The SQL spelling of a Neon isolation level: `RepeatableRead` is `repeatable read` */
function isolationOf(level: string | undefined): string | undefined {
    return level?.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function throwFirstError(response: WireResponse): void {
    const failed = response.statements.find((s) => s.status === "ERR");
    if (failed) throw NeonDbError.from(toStatementError(failed));
}

function shape(
    response: WireResponse,
    opts: HTTPQueryOptions<boolean, boolean>,
): FullQueryResults<boolean> | unknown[] {
    throwFirstError(response);
    const results = toQueryResults(response, {
        rowMode: opts.arrayMode ? "array" : undefined,
        types: opts.types,
    });
    const last = results[results.length - 1] ?? {
        command: "",
        rowCount: null,
        rows: [],
        fields: [],
    };
    if (!opts.fullResults) return last.rows;
    return {
        fields: last.fields,
        command: last.command,
        rowCount: last.rowCount,
        rows: last.rows as any,
        rowAsArray: !!opts.arrayMode,
        viaNeonFetch: true,
    };
}

/**
 * A query function over stateless HTTP, shaped like the one `@neondatabase/serverless` returns.
 * The namespace comes from the `ns` (or `namespace`) parameter of the connection string.
 *
 * ```ts
 * const sql = neon("postgres://root:root@abc.surrealdb.earth/app?ns=prod");
 * const rows = await sql`SELECT * FROM person WHERE name = ${name}`;
 * ```
 */
export function neon<ArrayMode extends boolean = false, FullResults extends boolean = false>(
    connectionString?: string,
    options: NeonOptions<ArrayMode, FullResults> = {},
): NeonQueryFunction<ArrayMode, FullResults> {
    const url = connectionString ?? envConnectionString();
    if (!url) {
        throw new Error(
            "No database connection string was provided to `neon()`. Pass one, or set DATABASE_URL.",
        );
    }

    const makeBackend = (override: {
        token?: AuthToken;
        fetchOptions?: Record<string, any>;
    }): SqlSession => {
        const fetchOptions = override.fetchOptions;
        const overrides: ConnectOptions = {
            fetch: (input, init) => {
                const send = options.fetchFunction ?? neonConfig.fetchFunction ?? fetch;
                const endpoint = neonConfig.fetchEndpoint;
                let target = input;
                if (endpoint !== undefined) {
                    if (typeof endpoint === "function") {
                        const parsed = new URL(String(input));
                        const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
                        target = endpoint(parsed.hostname, port, {
                            jwtAuth: override.token !== undefined,
                        });
                    } else target = endpoint;
                }
                const merged = fetchOptions
                    ? {
                          ...fetchOptions,
                          ...init,
                          headers: { ...fetchOptions.headers, ...(init?.headers as object) },
                      }
                    : init;
                return send(target, merged);
            },
        };
        if (override.token !== undefined) {
            overrides.auth =
                typeof override.token === "string" ? { token: override.token } : override.token;
        }
        return new SqlSession(new HttpTransport(resolveConfig(url, "pg", overrides)), "pgsql");
    };

    resolveConfig(url, "pg");
    let shared: SqlSession | undefined;

    const sessionFor = (opts: HTTPQueryOptions<boolean, boolean>): SqlSession => {
        if (opts.authToken === options.authToken && opts.fetchOptions === options.fetchOptions) {
            shared ??= makeBackend({
                token: options.authToken,
                fetchOptions: options.fetchOptions,
            });
            return shared;
        }
        return makeBackend({ token: opts.authToken, fetchOptions: opts.fetchOptions });
    };

    const callOf = (opts: HTTPQueryOptions<boolean, boolean>) => {
        const signal = opts.fetchOptions?.signal;
        return signal ? { signal: signal as AbortSignal } : undefined;
    };

    const runOne = async (query: NeonQueryPromise<any, any, any>) => {
        const opts = { ...options, ...query.opts };
        const session = sessionFor(opts);
        const { query: text, params } = query.parameterizedQuery;
        const response = await session.run(
            text,
            buildVars(params),
            { rowMode: "array", valueMode: "text" },
            callOf(opts),
        );
        return shape(response, opts);
    };

    const runAtomic = async (
        queries: NeonQueryPromise<any, any, any>[],
        txnOpts: HTTPTransactionOptions<boolean, boolean>,
    ) => {
        checkTransactionOptions({ ...options, ...txnOpts });
        for (const q of queries) {
            if (!(q instanceof NeonQueryPromise)) {
                throw new TypeError(
                    "transaction() takes queries made by this package's neon() function, not awaited results or other values",
                );
            }
        }
        if (queries.length === 0) return [];
        const base = { ...options, ...txnOpts };
        const session = sessionFor(base);
        const response = await session.run(
            queries.map((q) => ({
                text: q.parameterizedQuery.query,
                vars: buildVars(q.parameterizedQuery.params),
            })),
            undefined,
            {
                rowMode: "array",
                valueMode: "text",
                atomic: true,
                isolation: isolationOf(base.isolationLevel),
                readOnly: base.readOnly,
            },
            callOf(base),
        );
        throwFirstError(response);
        if (response.transaction.committed === false) {
            throw new Error("The transaction was not committed");
        }
        if (response.statements.length !== queries.length) {
            throw new Error(
                `A transaction of ${queries.length} queries answered ${response.statements.length} results; each query must be a single statement`,
            );
        }
        return queries.map((q, i) =>
            shape({ ...response, statements: [response.statements[i]] }, { ...base, ...q.opts }),
        );
    };

    const make = (text: string, params: unknown[], opts: HTTPQueryOptions<any, any> | undefined) =>
        new NeonQueryPromise({ query: text, params }, opts, runOne);

    const builder = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        if (!Array.isArray(strings) || !("raw" in strings)) throw new TypeError(TEMPLATE_MISUSE);
        let text = strings[0] ?? "";
        const params: unknown[] = [];
        values.forEach((value, i) => {
            if (value instanceof UnsafeRawSql) text += value.sql;
            else {
                params.push(value);
                text += `$${params.length}`;
            }
            text += strings[i + 1] ?? "";
        });
        return make(text, params, undefined);
    }) as NeonQueryInTransaction & NeonQueryFunction<ArrayMode, FullResults>;
    builder.query = ((text: string, params: unknown[] = [], opts?: HTTPQueryOptions<any, any>) =>
        make(text, params, opts)) as typeof builder.query;
    builder.unsafe = (sql) => new UnsafeRawSql(sql);
    builder.transaction = (async (queriesOrFn, txnOpts = {}) => {
        const queries = typeof queriesOrFn === "function" ? queriesOrFn(builder) : queriesOrFn;
        return runAtomic(queries, txnOpts);
    }) as NeonQueryFunction<ArrayMode, FullResults>["transaction"];
    return builder;
}
