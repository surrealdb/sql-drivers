/**
 * A stand-in for Neon's `/sql` HTTP endpoint, so the real `@neondatabase/serverless` package can
 * run in the conformance suites. It speaks Neon's documented request and response shapes (the
 * `Neon-*` headers, `{ query, params }` and `{ queries }` bodies, array-mode rows of text) over
 * the PGlite contract simulator, which supplies a real PostgreSQL.
 */
import type { PgliteEngine } from "./pglite-engine";

interface Entry {
    query: string;
    params?: unknown[];
}

interface Statement {
    status: string;
    command?: { tag: string; rows_affected: number };
    columns?: { name: string; type: { oid: number } }[];
    rows?: unknown[][];
    error?: { message: string; severity?: string; sqlstate?: string; position?: number | null };
}

const ISOLATION: Record<string, string> = {
    ReadUncommitted: "read uncommitted",
    ReadCommitted: "read committed",
    RepeatableRead: "repeatable read",
    Serializable: "serializable",
};

function varsOf(params: unknown[] | undefined): Record<string, unknown> {
    return Object.fromEntries((params ?? []).map((v, i) => [`p${i + 1}`, v]));
}

function resultOf(s: Statement) {
    const tag = s.command?.tag ?? "";
    return {
        command: tag.split(" ")[0],
        rowCount: s.command?.rows_affected ?? 0,
        fields: (s.columns ?? []).map((c) => ({
            name: c.name,
            dataTypeID: c.type.oid,
            tableID: 0,
            columnID: 0,
            dataTypeSize: -1,
            dataTypeModifier: -1,
            format: "text",
        })),
        rows: s.rows ?? [],
    };
}

function failure(error: NonNullable<Statement["error"]>): Response {
    return new Response(
        JSON.stringify({
            message: error.message,
            severity: error.severity ?? "ERROR",
            code: error.sqlstate,
            position: error.position == null ? undefined : String(error.position),
        }),
        { status: 400, headers: { "content-type": "application/json" } },
    );
}

export interface NeonRequest {
    url: string;
    headers: Record<string, string>;
    body: { query?: string; params?: unknown[]; queries?: Entry[] };
}

/** A `fetch` answering Neon `/sql` requests from the simulator; requests are recorded. */
export function neonFake(engine: PgliteEngine) {
    const requests: NeonRequest[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = Object.fromEntries(
            Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
                k.toLowerCase(),
                v,
            ]),
        );
        const body = JSON.parse(String(init?.body));
        requests.push({ url: String(input), headers, body });
        if (!headers["neon-connection-string"]) {
            return new Response(JSON.stringify({ message: "missing connection string" }), {
                status: 400,
            });
        }
        const send = async (entries: unknown[], options: Record<string, unknown>) =>
            (await engine.handle("http", "pgsql", [entries, null, options])) as {
                statements: Statement[];
            };
        const base = { rowMode: "array", valueMode: "text" };
        if (body.queries) {
            const level = headers["neon-batch-isolation-level"];
            const response = await send(
                (body.queries as Entry[]).map((q) => ({ text: q.query, vars: varsOf(q.params) })),
                {
                    ...base,
                    atomic: true,
                    isolation: level ? ISOLATION[level] : undefined,
                    readOnly: headers["neon-batch-read-only"] === "true" ? true : undefined,
                },
            );
            const failed = response.statements.find((s) => s.status === "ERR");
            if (failed?.error) return failure(failed.error);
            return Response.json({ results: response.statements.map(resultOf) });
        }
        const response = await send([{ text: body.query, vars: varsOf(body.params) }], base);
        const statement = response.statements[response.statements.length - 1];
        if (statement.status === "ERR" && statement.error) return failure(statement.error);
        return Response.json(resultOf(statement));
    }) as typeof fetch;
    return { fetch: fetchFn, requests };
}
