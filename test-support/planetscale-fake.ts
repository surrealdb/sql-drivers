/**
 * A stand-in for PlanetScale's HTTP API, so the real `@planetscale/database` package can run in
 * the conformance suites. It speaks the documented Vitess shapes: `Execute` and `CreateSession`
 * posts with an opaque `session`, `fields` named by Vitess type, and rows packed as one base64
 * string with a `lengths` array. SQLite (through the contract simulator) supplies the data.
 */
import type { SqliteMysqlEngine } from "./sqlite-mysql-engine";

const VITESS: Record<number, string> = {
    1: "INT8",
    2: "INT16",
    3: "INT32",
    5: "FLOAT64",
    7: "TIMESTAMP",
    8: "INT64",
    9: "INT24",
    10: "DATE",
    11: "TIME",
    12: "DATETIME",
    245: "JSON",
    246: "DECIMAL",
    252: "BLOB",
    253: "VARCHAR",
};

const NUMERIC = new Set(["INT8", "INT16", "INT24", "INT32", "INT64", "FLOAT64", "DECIMAL"]);

interface Column {
    name: string;
    type: { mysql_type: number };
    table: string | null;
    column: string | null;
}

interface Statement {
    status: string;
    command?: { tag: string; rows_affected: number; last_insert_id: number | null };
    columns?: Column[];
    rows?: (string | null)[][];
    error?: { message: string; errno?: number | null; sqlstate?: string | null };
}

const CODES: Record<number, string> = { 1062: "ALREADY_EXISTS", 1146: "UNKNOWN" };

function pack(row: (string | null)[]) {
    const lengths: string[] = [];
    let bytes = "";
    for (const value of row) {
        if (value === null) lengths.push("-1");
        else {
            const encoded = Buffer.from(value, "utf8");
            lengths.push(String(encoded.length));
            bytes += encoded.toString("latin1");
        }
    }
    return { lengths, values: Buffer.from(bytes, "latin1").toString("base64") };
}

export interface PlanetScaleRequest {
    url: string;
    headers: Record<string, string>;
    body: { query?: string; session?: unknown };
}

/** A `fetch` answering PlanetScale `Execute` and `CreateSession` posts; requests are recorded. */
export function planetscaleFake(engine: SqliteMysqlEngine) {
    const requests: PlanetScaleRequest[] = [];
    let sessions = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = Object.fromEntries(
            Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
                k.toLowerCase(),
                v,
            ]),
        );
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ url, headers, body });
        const respond = (payload: unknown) =>
            new Response(JSON.stringify(payload), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        if (url.endsWith("/CreateSession")) return respond({ session: { id: ++sessions } });
        const session = body.session ?? { id: ++sessions };
        const response = (await engine.handle("ws", "mysql", [
            body.query,
            null,
            { rowMode: "array", valueMode: "text" },
        ])) as { statements: Statement[] };
        const s = response.statements[response.statements.length - 1];
        if (!s) return respond({ session, result: { rowsAffected: "0", insertId: "0" } });
        if (s.status === "ERR" && s.error) {
            const code = (s.error.errno != null && CODES[s.error.errno]) || "UNKNOWN";
            return respond({
                session,
                error: { message: `target: app.-.primary: vttablet: ${s.error.message}`, code },
            });
        }
        const columns = s.columns ?? [];
        const fields = columns.map((c) => {
            const type = VITESS[c.type.mysql_type] ?? "VARCHAR";
            return {
                name: c.name,
                type,
                table: c.table ?? undefined,
                orgTable: c.table ?? undefined,
                database: "app",
                orgName: c.column ?? c.name,
                columnLength: type === "VARCHAR" ? 1020 : 20,
                charset: NUMERIC.has(type) || type === "BLOB" ? 63 : 255,
                flags: NUMERIC.has(type) ? 32768 : 0,
            };
        });
        return respond({
            session,
            result: {
                rowsAffected: String(columns.length > 0 ? 0 : (s.command?.rows_affected ?? 0)),
                insertId: String(s.command?.last_insert_id ?? 0),
                fields: fields.length ? fields : undefined,
                rows: (s.rows ?? []).map(pack),
            },
            timing: 0.001,
        });
    }) as typeof fetch;
    return { fetch: fetchFn, requests };
}
