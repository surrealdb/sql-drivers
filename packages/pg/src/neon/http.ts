import {
    buildVars,
    type ConnectOptions,
    HttpTransport,
    resolveConfig,
    SqlSession,
    SurrealSqlError,
    toStatementError,
    UnknownResponseError,
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

type Param<T> = T | (() => T | Promise<T>);

/** Connection parameters in place of, or on top of, a connection string; each may be a function. */
export interface ConnectionParams {
    connectionString?: Param<string>;
    user?: Param<string>;
    username?: Param<string>;
    password?: Param<string>;
    host?: Param<string>;
    hostname?: Param<string>;
    port?: Param<number | string>;
    database?: Param<string>;
}

export interface NeonOptions<ArrayMode extends boolean, FullResults extends boolean>
    extends HTTPTransactionOptions<ArrayMode, FullResults>,
        ConnectionParams {
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

    /** The template the query was made from, or its text and parameters */
    readonly queryData: SqlTemplate | Parameterized;
    readonly parameterizedQuery: Parameterized;

    constructor(
        queryData: SqlTemplate | Parameterized,
        readonly opts: HTTPQueryOptions<ArrayMode, FullResults> | undefined,
        run: (query: NeonQueryPromise<any, any, any>) => Promise<T>,
    ) {
        this.queryData = queryData;
        this.parameterizedQuery =
            queryData instanceof SqlTemplate ? queryData.toParameterizedQuery() : queryData;
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

/** A template with its values, flattened to numbered placeholders by `toParameterizedQuery`. */
export class SqlTemplate {
    constructor(
        readonly strings: readonly string[],
        readonly values: readonly unknown[],
    ) {}

    toParameterizedQuery(state: { params: unknown[] } = { params: [] }): Parameterized {
        let query = this.strings[0] ?? "";
        this.values.forEach((value, i) => {
            if (value instanceof UnsafeRawSql) query += value.sql;
            else if (value instanceof SqlTemplate) query += value.toParameterizedQuery(state).query;
            else if (value instanceof NeonQueryPromise) {
                const inner = value.queryData;
                if (inner instanceof SqlTemplate) query += inner.toParameterizedQuery(state).query;
                else {
                    const offset = state.params.length;
                    query += inner.query.replace(/\$(\d+)/g, (_, n) => `$${offset + Number(n)}`);
                    state.params.push(...inner.params);
                }
            } else {
                state.params.push(value);
                query += `$${state.params.length}`;
                if (value instanceof Uint8Array) query += "::bytea";
            }
            query += this.strings[i + 1] ?? "";
        });
        return { query, params: state.params };
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

/** Bytes cross as `\\x` hex text, which a `bytea` placeholder reads as written. */
function hexOf(bytes: Uint8Array): string {
    let out = "\\x";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
}

const prepare = (value: unknown): unknown => (value instanceof Uint8Array ? hexOf(value) : value);

/** A failure which is not a statement failure is reported as Neon reports a failed request. */
function wrapFailure(error: unknown): unknown {
    if (error instanceof NeonDbError || error instanceof TypeError) return error;
    if (error instanceof UnknownResponseError) {
        const wrapped = new NeonDbError(
            `Server error (HTTP status ${error.status}): ${error.body}`,
        );
        wrapped.sourceError = error;
        return wrapped;
    }
    if (error instanceof SurrealSqlError) {
        const wrapped = new NeonDbError(`Error connecting to database: ${error.message}`);
        wrapped.sourceError = (error.cause as Error | undefined) ?? error;
        return wrapped;
    }
    return error;
}

const PART_KEYS = [
    "connectionString",
    "user",
    "username",
    "password",
    "host",
    "hostname",
    "port",
    "database",
] as const;

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
    connectionString?: string | NeonOptions<ArrayMode, FullResults>,
    extraOptions: NeonOptions<ArrayMode, FullResults> = {},
): NeonQueryFunction<ArrayMode, FullResults> {
    const options: NeonOptions<ArrayMode, FullResults> =
        typeof connectionString === "object"
            ? { ...connectionString, ...extraOptions }
            : extraOptions;
    const given =
        typeof connectionString === "string" ? connectionString : options.connectionString;
    const parts: ConnectionParams = { ...options, connectionString: given };
    const dynamic = Object.values(parts).some((v) => typeof v === "function");
    const hasParts = PART_KEYS.some((k) => parts[k] !== undefined);
    if (!hasParts && envConnectionString()) parts.connectionString = envConnectionString();
    if (!PART_KEYS.some((k) => parts[k] !== undefined)) {
        throw new Error(
            "No database connection string was provided to `neon()`. Pass one, or set DATABASE_URL.",
        );
    }
    if (
        (parts.user !== undefined && parts.username !== undefined) ||
        (parts.host !== undefined && parts.hostname !== undefined)
    ) {
        throw new TypeError(
            "Specify either `user` or `username`, and either `host` or `hostname`, not both",
        );
    }

    const makeBackend = (override: {
        url: string;
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
        return new SqlSession(
            new HttpTransport(resolveConfig(override.url, "pg", overrides)),
            "pgsql",
        );
    };

    /** The connection string the parameters make */
    const buildUrl = (v: {
        base?: string;
        user?: string;
        password?: string;
        host?: string;
        port?: number | string;
        database?: string;
    }): string => {
        const wrong = () =>
            new NeonDbError(
                "Wrong URL scheme or missing user, host or database in connection parameters",
            );
        let target: URL;
        try {
            target = new URL(v.base ?? "postgres://localhost/");
        } catch {
            throw wrong();
        }
        if (v.user !== undefined) target.username = encodeURIComponent(v.user);
        if (v.password !== undefined) target.password = encodeURIComponent(v.password);
        if (v.host !== undefined) target.hostname = v.host;
        if (v.port !== undefined) target.port = String(v.port);
        if (v.database !== undefined) target.pathname = `/${v.database}`;
        const text = target.toString();
        if (!/^postgres(ql)?:\/\//.test(text) || !target.hostname) throw wrong();
        return text;
    };

    /** Functions among the parameters are called for each query */
    const resolveUrl = async (): Promise<string> => {
        const value = async <T>(v: Param<T> | undefined): Promise<T | undefined> =>
            typeof v === "function" ? await (v as () => T | Promise<T>)() : v;
        return buildUrl({
            base: await value(parts.connectionString),
            user: await value(parts.user ?? parts.username),
            password: await value(parts.password),
            host: await value(parts.host ?? parts.hostname),
            port: await value(parts.port),
            database: await value(parts.database),
        });
    };

    const staticUrl = dynamic
        ? undefined
        : buildUrl({
              base: parts.connectionString as string | undefined,
              user: (parts.user ?? parts.username) as string | undefined,
              password: parts.password as string | undefined,
              host: (parts.host ?? parts.hostname) as string | undefined,
              port: parts.port as number | string | undefined,
              database: parts.database as string | undefined,
          });
    if (staticUrl) resolveConfig(staticUrl, "pg");
    const sessions = new Map<string, SqlSession>();

    const sessionFor = async (opts: HTTPQueryOptions<boolean, boolean>): Promise<SqlSession> => {
        const url = staticUrl ?? (await resolveUrl());
        if (opts.authToken === options.authToken && opts.fetchOptions === options.fetchOptions) {
            let shared = sessions.get(url);
            if (!shared) {
                shared = makeBackend({
                    url,
                    token: options.authToken,
                    fetchOptions: options.fetchOptions,
                });
                sessions.set(url, shared);
            }
            return shared;
        }
        return makeBackend({ url, token: opts.authToken, fetchOptions: opts.fetchOptions });
    };

    const callOf = (opts: HTTPQueryOptions<boolean, boolean>) => {
        const signal = opts.fetchOptions?.signal;
        return signal ? { signal: signal as AbortSignal } : undefined;
    };

    const runOne = async (query: NeonQueryPromise<any, any, any>) => {
        const opts = { ...options, ...query.opts };
        const session = await sessionFor(opts);
        const { query: text, params } = query.parameterizedQuery;
        try {
            const response = await session.run(
                text,
                buildVars(params.map(prepare)),
                { rowMode: "array", valueMode: "text" },
                callOf(opts),
            );
            return shape(response, opts);
        } catch (error) {
            throw wrapFailure(error);
        }
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
        for (const q of queries) {
            const text = q.parameterizedQuery.query.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "");
            if (/;\s*\S/.test(text)) {
                throw new TypeError(
                    "Each query of a transaction must be a single statement; send several as separate queries",
                );
            }
        }
        const base = { ...options, ...txnOpts };
        const session = await sessionFor(base);
        let response: WireResponse;
        try {
            response = await session.run(
                queries.map((q) => ({
                    text: q.parameterizedQuery.query,
                    vars: buildVars(q.parameterizedQuery.params.map(prepare)),
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
        } catch (error) {
            throw wrapFailure(error);
        }
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
        return new NeonQueryPromise(new SqlTemplate(strings, values), undefined, runOne);
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
