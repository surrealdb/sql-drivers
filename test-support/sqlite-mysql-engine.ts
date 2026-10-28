/**
 * A contract simulator for the `mysql` RPC method: SQLite (node:sqlite) behind the engine's
 * "Client contract" shapes. SQLite is not MySQL, so tests create their tables in SQLite syntax
 * and avoid MySQL-only statements; what it exercises is the client's call forms, result shapes
 * and adapter code paths, not MySQL semantics.
 */
import { DatabaseSync } from "node:sqlite";

type Status = "idle" | "active" | "failed";

const DECLARED: [RegExp, number][] = [
    [/datetime/i, 12],
    [/timestamp/i, 7],
    [/^date$/i, 10],
    [/time/i, 11],
    [/bigint/i, 8],
    [/int/i, 3],
    [/double|real|float/i, 5],
    [/decimal|numeric/i, 246],
    [/json/i, 245],
];

function mysqlType(declared: string | null, sample: unknown): number {
    if (declared) for (const [re, code] of DECLARED) if (re.test(declared)) return code;
    if (typeof sample === "bigint") return 8;
    if (typeof sample === "number") return Number.isInteger(sample) ? 8 : 5;
    return 253;
}

function textOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    return String(value);
}

export class SqliteMysqlEngine {
    readonly calls: { method: string; params: unknown[] }[] = [];
    #db = new DatabaseSync(":memory:");
    #status: Status = "idle";

    close(): void {
        this.#db.close();
    }

    #run(
        text: string,
        vars: Record<string, unknown> | undefined,
        valueMode: string | undefined,
        rowMode: string | undefined,
    ) {
        const first = text.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
        const second = text.trim().split(/\s+/)[1]?.toUpperCase() ?? "";
        if (first === "SET" && second === "TRANSACTION") return ok("SET", 0, [], [], null);
        let sql = text;
        if (first === "START" && second === "TRANSACTION") sql = "BEGIN";
        const keys = vars
            ? Object.keys(vars).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
            : [];
        const params = keys.map((k) => {
            const v = (vars as Record<string, unknown>)[k];
            return typeof v === "boolean" ? Number(v) : (v as never);
        });
        try {
            const statement = this.#db.prepare(sql);
            const columns = statement.columns();
            if (columns.length > 0) {
                statement.setReturnArrays(true);
                const raw = statement.all(...params) as unknown as unknown[][];
                const cols = columns.map((c, i) => ({
                    name: c.name,
                    type: { name: "text", mysql_type: mysqlType(c.type, raw[0]?.[i]) },
                    nullable: null,
                    table: c.table,
                    column: c.column,
                }));
                const rows = raw.map((r) =>
                    valueMode === "text"
                        ? r.map(textOf)
                        : r.map((v) => (typeof v === "bigint" ? Number(v) : v)),
                );
                const out =
                    rowMode === "array"
                        ? rows
                        : rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i]])));
                return ok("SELECT", rows.length, cols, out, null);
            }
            const result = statement.run(...params);
            if (first === "START" || first === "BEGIN") this.#status = "active";
            else if (first === "COMMIT" || first === "ROLLBACK") this.#status = "idle";
            return ok(
                first,
                Number(result.changes),
                [],
                [],
                first === "INSERT" ? Number(result.lastInsertRowid) : null,
            );
        } catch (error) {
            if (this.#status === "active") this.#status = "failed";
            const message = (error as Error).message;
            const dup = /UNIQUE constraint failed/.test(message);
            const missing = /no such table/.test(message);
            return {
                status: "ERR",
                error: {
                    message,
                    severity: "ERROR",
                    sqlstate: dup ? "23000" : missing ? "42S02" : "HY000",
                    errno: dup ? 1062 : missing ? 1146 : 1105,
                    position: null,
                },
            };
        }
    }

    async handle(kind: "http" | "ws", method: string, params: unknown[]): Promise<unknown> {
        this.calls.push({ method, params });
        if (method === "signin") return "simulated-token";
        if (method === "use" || method === "authenticate" || method === "query_cancel") return null;
        if (method === "version") return "surrealdb-simulator";
        if (method !== "mysql")
            throw { code: -32601, kind: "NotFound", message: "Method not found" };
        const [input, vars, options] = params as [
            string | (string | { text: string; vars?: Record<string, unknown> })[],
            Record<string, unknown> | null,
            { rowMode?: string; valueMode?: string; atomic?: boolean } | undefined,
        ];
        const entries = (Array.isArray(input) ? input : [input]).map((e) =>
            typeof e === "string"
                ? { text: e, vars: vars ?? undefined }
                : { text: e.text, vars: { ...(vars ?? {}), ...(e.vars ?? {}) } },
        );
        const statements: unknown[] = [];
        if (options?.atomic) this.#run("BEGIN", undefined, undefined, undefined);
        for (const entry of entries) {
            if (entry.text.trim() === "") continue;
            for (const part of splitTop(entry.text)) {
                if (
                    kind === "http" &&
                    /^\s*(begin|start transaction)\b/i.test(part) &&
                    !options?.atomic
                ) {
                    statements.push({
                        status: "ERR",
                        error: {
                            message: "BEGIN is not available over HTTP",
                            severity: "ERROR",
                            sqlstate: "HY000",
                            errno: 1295,
                            position: null,
                        },
                    });
                    continue;
                }
                statements.push(this.#run(part, entry.vars, options?.valueMode, options?.rowMode));
            }
        }
        if (options?.atomic) {
            const failed = (statements as { status: string }[]).some((s) => s.status === "ERR");
            this.#run(failed ? "ROLLBACK" : "COMMIT", undefined, undefined, undefined);
        }
        if (kind === "http" && !options?.atomic && this.#status !== "idle")
            this.#run("ROLLBACK", undefined, undefined, undefined);
        return { statements, transaction: { status: kind === "http" ? "idle" : this.#status } };
    }

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

function ok(
    tag: string,
    count: number,
    columns: unknown[],
    rows: unknown[],
    insertId: number | null,
) {
    return {
        status: "OK",
        time: "1µs",
        command: { tag, rows_affected: count, last_insert_id: insertId, warnings: 0 },
        columns,
        rows,
    };
}

function splitTop(text: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (const ch of text) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"' || ch === "`") {
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
