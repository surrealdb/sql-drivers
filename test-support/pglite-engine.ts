/**
 * A contract simulator: a real PostgreSQL (PGlite) behind the `pgsql` RPC method shapes of the
 * engine's "Client contract". It lets the adapter suites run real ORM code paths before an engine
 * build is available, and is not a substitute for the integration suite against a server.
 *
 * Differences from the engine which the simulator cannot hide: one PGlite connection serves every
 * session, so tests which hold transactions on two sessions at once are not supported.
 */
import { PGlite } from "@electric-sql/pglite";
import { arrayElements, builtins, oidByName } from "../packages/pg/src/oids";

const nameByOid = new Map<number, string>(Object.entries(oidByName).map(([n, o]) => [o, n]));

function typeOf(oid: number): {
    name: string;
    oid: number;
    element?: { name: string; oid: number };
} {
    const element = arrayElements[oid];
    if (element !== undefined) {
        const e = { name: nameByOid.get(element) ?? "text", oid: element };
        return { name: `_${e.name}`, oid, element: e };
    }
    return { name: nameByOid.get(oid) ?? "text", oid };
}

const RAW_OIDS = [
    ...Object.values(builtins),
    ...Object.keys(arrayElements).map(Number),
    18,
    24,
    142,
    194,
    600,
    650,
    700,
    790,
    829,
    869,
    1005,
    1033,
    1034,
    1041,
    1263,
    1560,
    1562,
    2205,
];

function tagFor(sql: string, rowCount: number): string {
    const words = sql.trim().replace(/^\(+/, "").split(/\s+/);
    const first = (words[0] ?? "").toUpperCase();
    if (
        first === "SELECT" ||
        first === "WITH" ||
        first === "VALUES" ||
        first === "SHOW" ||
        first === "TABLE"
    ) {
        return `SELECT ${rowCount}`;
    }
    if (first === "INSERT") return `INSERT 0 ${rowCount}`;
    if (first === "UPDATE" || first === "DELETE" || first === "MERGE")
        return `${first} ${rowCount}`;
    if (first === "CREATE" || first === "DROP" || first === "ALTER") {
        return `${first} ${(words[1] ?? "").toUpperCase()}`.trim();
    }
    if (first === "BEGIN" || first === "START") return "BEGIN";
    if (first === "ROLLBACK") return "ROLLBACK";
    if (first === "END") return "COMMIT";
    return first;
}

/** The contract's native JSON value for the text form of a value of the given type. */
function nativeValue(text: string | null, oid: number): unknown {
    if (text === null) return null;
    switch (oid) {
        case 16:
            return text === "t";
        case 21:
        case 23:
        case 700:
        case 701:
            return Number(text);
        case 20: {
            const n = Number(text);
            return Number.isSafeInteger(n) ? n : text;
        }
        case 114:
        case 3802:
            return JSON.parse(text);
        case 17:
            return btoa(
                String.fromCharCode(
                    ...(text.slice(2).match(/../g) ?? []).map((h) => Number.parseInt(h, 16)),
                ),
            );
        default:
            return text;
    }
}

type Status = "idle" | "active" | "failed";

export interface EngineStats {
    calls: { method: string; params: unknown[] }[];
}

export class PgliteEngine {
    readonly stats: EngineStats = { calls: [] };
    #db: PGlite;
    #queue: Promise<unknown> = Promise.resolve();
    #status: Status = "idle";

    private constructor(db: PGlite) {
        this.#db = db;
    }

    static async create(): Promise<PgliteEngine> {
        const db = new PGlite();
        await db.waitReady;
        return new PgliteEngine(db);
    }

    async close(): Promise<void> {
        await this.#db.close();
    }

    /** Run a function after every earlier one, so concurrent sessions do not interleave. */
    #serial<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.#queue.then(fn, fn);
        this.#queue = next.catch(() => {});
        return next;
    }

    async #runOne(
        text: string,
        vars: Record<string, unknown> | undefined,
        rowMode: string | undefined,
        valueMode: string | undefined,
    ) {
        const keys = vars
            ? Object.keys(vars).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
            : [];
        const params = keys.map((k) => (vars as Record<string, unknown>)[k]);
        const parsers = Object.fromEntries(RAW_OIDS.map((o) => [o, (v: string) => v]));
        const first = text.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
        if (
            this.#status === "failed" &&
            first !== "ROLLBACK" &&
            first !== "END" &&
            first !== "COMMIT"
        ) {
            return {
                status: "ERR",
                error: {
                    message:
                        "current transaction is aborted, commands ignored until end of transaction block",
                    severity: "ERROR",
                    sqlstate: "25P02",
                    errno: null,
                    position: null,
                },
            };
        }
        try {
            const result = await this.#db.query<unknown[]>(text, params as unknown[], {
                rowMode: "array",
                parsers,
            });
            if (first === "BEGIN" || first === "START") this.#status = "active";
            else if (first === "COMMIT" || first === "ROLLBACK" || first === "END")
                this.#status = "idle";
            const native = valueMode !== "text";
            const convert = (row: unknown[]) =>
                native
                    ? row.map((v, i) =>
                          nativeValue(v as string | null, result.fields[i].dataTypeID),
                      )
                    : row;
            const rowsOut = result.rows.map(convert);
            const count = result.fields.length > 0 ? rowsOut.length : (result.affectedRows ?? 0);
            return {
                status: "OK",
                time: "1µs",
                command: {
                    tag: tagFor(text, count),
                    rows_affected: count,
                    last_insert_id: null,
                    warnings: 0,
                },
                columns: result.fields.map((f) => ({
                    name: f.name,
                    type: typeOf(f.dataTypeID),
                    nullable: null,
                    table: null,
                    column: null,
                })),
                rows:
                    rowMode === "array"
                        ? rowsOut
                        : rowsOut.map((r) =>
                              Object.fromEntries(result.fields.map((f, i) => [f.name, r[i]])),
                          ),
            };
        } catch (error) {
            if (this.#status === "active") this.#status = "failed";
            const e = error as {
                message: string;
                severity?: string;
                code?: string;
                position?: string;
            };
            return {
                status: "ERR",
                error: {
                    message: e.message,
                    severity: e.severity ?? "ERROR",
                    sqlstate: e.code ?? "XX000",
                    errno: null,
                    position: e.position ? Number(e.position) : null,
                },
            };
        }
    }

    /** Handle one RPC call. `kind` is the transport the call arrived on. */
    handle(kind: "http" | "ws", method: string, params: unknown[]): Promise<unknown> {
        this.stats.calls.push({ method, params });
        if (method === "signin") return Promise.resolve("simulated-token");
        if (method === "use" || method === "authenticate" || method === "query_cancel")
            return Promise.resolve(null);
        if (method === "version") return Promise.resolve("surrealdb-simulator");
        if (method !== "pgsql") {
            return Promise.reject({ code: -32601, kind: "NotFound", message: "Method not found" });
        }
        return this.#serial(async () => {
            const [input, vars, options] = params as [
                string | (string | { text: string; vars?: Record<string, unknown> })[],
                Record<string, unknown> | null,
                { rowMode?: string; atomic?: boolean; valueMode?: string } | undefined,
            ];
            const entries = (Array.isArray(input) ? input : [input]).map((e) =>
                typeof e === "string"
                    ? { text: e, vars: vars ?? undefined }
                    : { text: e.text, vars: { ...(vars ?? {}), ...(e.vars ?? {}) } },
            );
            const statements: unknown[] = [];
            const atomic = options?.atomic === true;
            if (atomic) {
                if (this.#status !== "idle") {
                    return {
                        statements: [
                            {
                                status: "ERR",
                                error: {
                                    message: "atomic call inside a transaction",
                                    sqlstate: "25001",
                                    errno: null,
                                    position: null,
                                },
                            },
                        ],
                        transaction: { status: this.#status },
                    };
                }
                await this.#runOne("BEGIN", undefined, undefined, undefined);
            }
            for (const entry of entries) {
                const hasVars = entry.vars && Object.keys(entry.vars).length > 0;
                const multi = !hasVars && /;\s*\S/.test(entry.text.replace(/'[^']*'/g, ""));
                if (kind === "http" && /^\s*(begin|start)\b/i.test(entry.text) && !atomic) {
                    statements.push({
                        status: "ERR",
                        error: {
                            message: "BEGIN is not available over HTTP; use an atomic batch",
                            severity: "ERROR",
                            sqlstate: "25000",
                            errno: null,
                            position: null,
                        },
                    });
                    continue;
                }
                if (multi) {
                    for (const part of splitStatements(entry.text)) {
                        statements.push(
                            await this.#runOne(
                                part,
                                undefined,
                                options?.rowMode,
                                options?.valueMode,
                            ),
                        );
                    }
                } else if (entry.text.trim() === "") {
                } else {
                    statements.push(
                        await this.#runOne(
                            entry.text,
                            entry.vars,
                            options?.rowMode,
                            options?.valueMode,
                        ),
                    );
                }
            }
            if (atomic) {
                const failed = (statements as { status: string }[]).some((s) => s.status === "ERR");
                await this.#runOne(failed ? "ROLLBACK" : "COMMIT", undefined, undefined, undefined);
                if (failed) this.#status = "idle";
            }
            if (kind === "http" && !atomic) {
                // HTTP holds no transaction between requests
                if (this.#status !== "idle")
                    await this.#runOne("ROLLBACK", undefined, undefined, undefined);
                return { statements, transaction: { status: "idle" } };
            }
            return { statements, transaction: { status: this.#status } };
        });
    }

    /** A `fetch` for the HTTP transport. */
    get fetch(): typeof fetch {
        return (async (_url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as {
                id: number;
                method: string;
                params: unknown[];
            };
            try {
                const result = await this.handle("http", body.method, body.params);
                return new Response(JSON.stringify({ id: body.id, result }), {
                    headers: { "content-type": "application/json" },
                });
            } catch (error) {
                return new Response(JSON.stringify({ id: body.id, error }), {
                    headers: { "content-type": "application/json" },
                });
            }
        }) as unknown as typeof fetch;
    }
}

/** Split text into statements at top-level semicolons. */
export function splitStatements(text: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (const ch of text) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
        } else if (ch === ";") {
            if (current.trim()) parts.push(current.trim());
            current = "";
        } else current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}
