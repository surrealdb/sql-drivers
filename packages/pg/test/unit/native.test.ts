import {
    CapabilityDeniedError,
    connect,
    RecordId,
    StatementError,
    UnsupportedOnTransportError,
} from "@surrealdb/pg";
import {
    answering,
    describePg,
    emptyOk,
    FakeSocket,
    selectPersonPg,
    selectPersonPgArray,
    statementErrorPg,
} from "@surrealdb/sql-internal/testing";
import { describe, expect, it } from "vitest";

type Body = { method: string; params: any[] };

function client(reply: (body: Body) => unknown, extra = {}) {
    const calls: Body[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Body;
        calls.push(body);
        const result = reply(body);
        if (result instanceof Response) return result;
        return new Response(JSON.stringify({ id: 1, result }), {
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    const sql = connect({
        url: "postgres://root:root@localhost/app?ns=prod",
        fetch: fetchImpl,
        WebSocket: FakeSocket as any,
        ...extra,
    });
    return { sql, calls };
}

describe("native query forms", () => {
    it("runs a tagged template with $n placeholders and _n vars, resolving rows", async () => {
        const { sql, calls } = client(() => selectPersonPg);
        const rows = await sql`SELECT id, name FROM person WHERE name = ${"Tobie"} AND age > ${3}`;
        expect(rows).toEqual([{ id: "person:tobie", name: "Tobie" }]);
        expect(calls[0]).toEqual({
            id: 1,
            method: "pgsql",
            params: [
                "SELECT id, name FROM person WHERE name = $1 AND age > $2",
                { _1: "Tobie", _2: 3 },
            ],
        });
    });

    it("rejects the plain call form instead of sending unbound placeholders", () => {
        const { sql } = client(() => selectPersonPg);
        expect(() => (sql as any)("SELECT $1", [1])).toThrow(/tagged template/);
    });

    it("query returns a full result with columns, command and row count", async () => {
        const { sql, calls } = client(() => selectPersonPgArray);
        const r = await sql.query("SELECT id, name FROM person WHERE id = $1", ["person:tobie"], {
            rowMode: "array",
        });
        expect(r.rows).toEqual([["person:tobie", "Tobie"]]);
        expect(r.columns.map((c) => [c.name, c.typeName, c.oid])).toEqual([
            ["id", "text", 25],
            ["name", "text", 25],
        ]);
        expect(r.command).toBe("SELECT 1");
        expect(r.rowCount).toBe(1);
        expect(calls[0].params[2]).toEqual({ rowMode: "array" });
    });

    it("throws a StatementError carrying sqlstate and position", async () => {
        const { sql } = client(() => statementErrorPg);
        const error: any = await sql.query("SELECT * FROM nope").catch((e) => e);
        expect(error).toBeInstanceOf(StatementError);
        expect(error).toMatchObject({ sqlstate: "42P01", position: 15, severity: "ERROR" });
    });

    it("nests templates and raw text sharing one counter", async () => {
        const { sql, calls } = client(() => emptyOk("SELECT 0"));
        const cond = sql`age > ${30}`;
        await sql`SELECT * FROM person WHERE name = ${"a"} AND ${cond} ORDER BY ${sql.raw("name")}`;
        expect(calls[0].params[0]).toBe(
            "SELECT * FROM person WHERE name = $1 AND age > $2 ORDER BY name",
        );
        expect(calls[0].params[1]).toEqual({ _1: "a", _2: 30 });
    });

    it("sends the multi-statement call and exposes every result", async () => {
        const two = {
            ...emptyOk("INSERT 0 1"),
            statements: [...emptyOk("INSERT 0 1").statements, ...selectPersonPg.statements],
        };
        const { sql } = client(() => two);
        const r = await sql.query("INSERT INTO person (name) VALUES ('a'); SELECT 1");
        expect(r.command).toBe("SELECT 1");
        expect(r.results.map((x) => x.command)).toEqual(["INSERT 0 1", "SELECT 1"]);
    });
});

describe("decoding", () => {
    const columns = (name: string, type: any) => ({
        name,
        type,
        nullable: null,
        table: null,
        column: null,
    });
    it("decodes by wire type", async () => {
        const response = {
            statements: [
                {
                    status: "OK",
                    command: {
                        tag: "SELECT 1",
                        rows_affected: 1,
                        last_insert_id: null,
                        warnings: 0,
                    },
                    columns: [
                        columns("big", { name: "int8", oid: 20 }),
                        columns("n", { name: "numeric", oid: 1700 }),
                        columns("ts", { name: "timestamptz", oid: 1184 }),
                        columns("d", { name: "timestamp", oid: 1114 }),
                        columns("b", { name: "bytea", oid: 17 }),
                        columns("r", { name: "record" }),
                        columns("v", { name: "vector" }),
                        columns("arr", {
                            name: "_int4",
                            oid: 1007,
                            element: { name: "int4", oid: 23 },
                        }),
                        columns("nul", { name: "text", oid: 25 }),
                    ],
                    rows: [
                        {
                            big: "9223372036854775807",
                            n: "1.10",
                            ts: "2026-01-02T03:04:05Z",
                            d: "2026-01-02T03:04:05",
                            b: "AQID",
                            r: "person:tobie",
                            v: [1, 2],
                            arr: [1, 2],
                            nul: null,
                        },
                    ],
                },
            ],
            transaction: { status: "idle" },
        };
        const { sql } = client(() => response);
        const [row] = await sql`SELECT 1`;
        expect(row.big).toBe(9223372036854775807n);
        expect(row.n).toBe("1.10");
        expect(row.ts).toEqual(new Date("2026-01-02T03:04:05Z"));
        expect(row.d).toEqual(new Date("2026-01-02T03:04:05Z"));
        expect(row.b).toEqual(new Uint8Array([1, 2, 3]));
        expect(row.r).toEqual(new RecordId("person", "tobie"));
        expect(row.v).toEqual(new Float32Array([1, 2]));
        expect(row.arr).toEqual([1, 2]);
        expect(row.nul).toBeNull();
    });
});

describe("batch and settings", () => {
    it("sends one atomic call with per-entry vars and returns results in order", async () => {
        const { sql, calls } = client(() => ({
            statements: [...emptyOk("INSERT 0 1").statements, ...selectPersonPg.statements],
            transaction: { status: "idle" },
        }));
        const [a, b] = await sql.batch([
            sql`INSERT INTO person (name) VALUES (${"a"})`,
            sql`SELECT count(*) FROM person`,
        ]);
        expect(a.command).toBe("INSERT 0 1");
        expect(b.command).toBe("SELECT 1");
        expect(calls[0].params).toEqual([
            [
                { text: "INSERT INTO person (name) VALUES ($1)", vars: { _1: "a" } },
                { text: "SELECT count(*) FROM person" },
            ],
            null,
            { atomic: true },
        ]);
    });

    it("prepends settings on every HTTP call and strips their results", async () => {
        const setOk = {
            status: "OK",
            command: { tag: "SET", rows_affected: 0, last_insert_id: null, warnings: 0 },
            columns: [],
            rows: [],
        };
        const { sql, calls } = client(
            () => ({
                statements: [setOk, ...selectPersonPg.statements],
                transaction: { status: "idle" },
            }),
            { settings: { timezone: "UTC" } },
        );
        const rows = await sql`SELECT id, name FROM person`;
        expect(rows).toHaveLength(1);
        expect(calls[0].params[0]).toEqual(["SET timezone = 'UTC'", "SELECT id, name FROM person"]);
    });

    it("surfaces a failing setting by name", async () => {
        const bad = {
            status: "ERR",
            error: { message: "unrecognized configuration parameter", sqlstate: "42704" },
        };
        const { sql } = client(() => ({ statements: [bad], transaction: { status: "idle" } }), {
            settings: { nope: "x" },
        });
        await expect(sql`SELECT 1`).rejects.toThrow(/session setting failed/);
    });

    it("returns per-entry errors when throwOnError is false", async () => {
        const { sql } = client(() => ({
            statements: [...statementErrorPg.statements, ...selectPersonPg.statements],
            transaction: { status: "idle" },
        }));
        const out = await sql.batch(["SELECT * FROM nope", "SELECT 1"], { throwOnError: false });
        expect(out[0]).toBeInstanceOf(StatementError);
        expect((out[1] as any).command).toBe("SELECT 1");
    });
});

describe("introspection", () => {
    it("describe sends the describe option and returns columns and params", async () => {
        const { sql, calls } = client(() => describePg);
        const d = await sql.describe("SELECT name FROM person WHERE name = $1");
        expect(calls[0].params).toEqual([
            "SELECT name FROM person WHERE name = $1",
            null,
            { describe: true },
        ]);
        expect(d.columns[0].typeName).toBe("text");
        expect(d.params).toEqual([{ name: "text", oid: 25 }]);
    });

    it("capabilities reports a denied method", async () => {
        const { sql } = client((b) => {
            if (b.method === "version") return "surrealdb-4.0.0";
            return new Response(
                JSON.stringify({
                    id: 1,
                    error: {
                        code: -32002,
                        kind: "NotAllowed",
                        message: "Method not allowed: pgsql",
                        details: { kind: "Method" },
                    },
                }),
            );
        });
        const c = await sql.capabilities();
        expect(c.supported).toBe(false);
        expect(c.reason).toMatch(/not allowed/i);
        expect(c.version).toBe("surrealdb-4.0.0");
        expect(CapabilityDeniedError).toBeDefined();
    });
});

describe("transactions and live over WebSocket", () => {
    it("begin runs BEGIN, the callback and COMMIT on one dedicated session", async () => {
        const seen: string[] = [];
        FakeSocket.reset(
            answering((method, params) => {
                if (method === "pgsql") {
                    seen.push(String(params[0]));
                    return emptyOk("OK");
                }
                return null;
            }),
        );
        const { sql } = client(() => emptyOk("X"));
        const out = await sql.begin(async (tx) => {
            await tx`UPDATE a SET b = ${1}`;
            return "done";
        });
        expect(out).toBe("done");
        expect(seen).toEqual(["BEGIN", "UPDATE a SET b = $1", "COMMIT"]);
        expect(FakeSocket.instances).toHaveLength(1);
        expect(FakeSocket.instances[0].readyState).toBe(3);
    });

    it("opens a transaction with an isolation level through the begin method and carries its id", async () => {
        const sent: { method: string; params: unknown[]; txn?: unknown }[] = [];
        FakeSocket.reset((socket, m) => {
            sent.push({ method: m.method, params: m.params, txn: m.txn });
            const result =
                m.method === "signin"
                    ? "tok"
                    : m.method === "begin"
                      ? "txn-1"
                      : m.method === "pgsql"
                        ? emptyOk("OK")
                        : null;
            socket.reply({ id: m.id, result });
        });
        const { sql } = client(() => emptyOk("X"));
        await sql.begin(
            async (tx) => {
                await tx`UPDATE a SET b = ${1}`;
            },
            { isolation: "repeatable read", readOnly: true },
        );
        const rpc = sent.filter((m) => ["begin", "pgsql", "commit"].includes(m.method));
        expect(rpc.map((m) => m.method)).toEqual(["begin", "pgsql", "commit"]);
        expect(rpc[0].params).toEqual([{ isolation: "snapshot", read_only: {} }]);
        expect(rpc[1].txn).toBe("txn-1");
        expect(rpc[2].params).toEqual(["txn-1"]);
    });

    it("rejects an unknown isolation level", async () => {
        const { sql } = client(() => emptyOk("X"));
        await expect(sql.begin(async () => 1, { isolation: "chaos" as never })).rejects.toThrow(
            /Unknown isolation level/,
        );
    });

    it("rolls back on a throw and keeps the original error even when rollback fails", async () => {
        const seen: string[] = [];
        FakeSocket.reset(
            answering((method, params) => {
                if (method === "pgsql") {
                    seen.push(String(params[0]));
                    if (params[0] === "ROLLBACK") throw new Error("rollback exploded");
                    return emptyOk("OK");
                }
                return null;
            }),
        );
        // a script that throws inside reply would break the socket; answer ROLLBACK with an RPC error instead
        FakeSocket.script = (socket, m) => {
            if (m.method === "pgsql" && m.params[0] === "ROLLBACK") {
                seen.push("ROLLBACK");
                socket.reply({ id: m.id, error: { code: -32000, message: "rollback exploded" } });
            } else if (m.method === "pgsql") {
                seen.push(String(m.params[0]));
                socket.reply({ id: m.id, result: emptyOk("OK") });
            } else socket.reply({ id: m.id, result: m.method === "signin" ? "tok" : null });
        };
        const { sql } = client(() => emptyOk("X"));
        await expect(
            sql.begin(async () => {
                throw new Error("original");
            }),
        ).rejects.toThrow("original");
        expect(seen).toEqual(["BEGIN", "ROLLBACK"]);
    });

    it("refuses begin and live when pinned to http", async () => {
        const { sql } = client(() => emptyOk("X"), { transport: "http" });
        await expect(sql.begin(async () => 1)).rejects.toBeInstanceOf(UnsupportedOnTransportError);
        expect(() => sql.live("person")).toThrow(UnsupportedOnTransportError);
    });

    it("live yields notifications for its id and kills the query on return", async () => {
        const kills: unknown[] = [];
        FakeSocket.reset(
            answering((method, params) => {
                if (method === "live") return "q-1";
                if (method === "kill") {
                    kills.push(params[0]);
                    return null;
                }
                return null;
            }),
        );
        const { sql } = client(() => emptyOk("X"), { transport: "ws" });
        const iterator = sql.live<{ a: number }>("person")[Symbol.asyncIterator]();
        const first = iterator.next();
        await new Promise((r) => setTimeout(r, 10));
        const socket = FakeSocket.instances[0];
        socket.reply({ result: { action: "CREATE", id: "other", result: { a: 0 } } });
        socket.reply({ result: { action: "CREATE", id: "q-1", result: { a: 1 } } });
        expect((await first).value).toEqual({ action: "CREATE", id: "q-1", result: { a: 1 } });
        await iterator.return?.();
        expect(kills).toEqual(["q-1"]);
    });

    it("surql binds values as variables and record ids as type::record", async () => {
        const { sql, calls } = client(() => [{ status: "OK", result: [{ id: "person:tobie" }] }]);
        const out =
            await sql.surql`SELECT * FROM ${new RecordId("person", "tobie")} WHERE age > ${3}`;
        expect(out).toEqual([[{ id: "person:tobie" }]]);
        expect(calls[0].method).toBe("query");
        expect(calls[0].params).toEqual([
            "SELECT * FROM type::record($p1) WHERE age > $p2",
            { p1: "person:tobie", p2: 3 },
        ]);
    });
});

describe("review regressions", () => {
    it("fails when a session setting fails over WebSocket instead of ignoring it", async () => {
        FakeSocket.reset(
            answering((method) =>
                method === "pgsql"
                    ? {
                          statements: [
                              {
                                  status: "ERR",
                                  error: {
                                      message: "unrecognized configuration parameter",
                                      sqlstate: "42704",
                                  },
                              },
                          ],
                          transaction: { status: "idle" },
                      }
                    : null,
            ),
        );
        const { sql } = client(() => emptyOk("X"), { transport: "ws", settings: { nope: "x" } });
        await expect(sql`SELECT 1`).rejects.toThrow(/session setting failed/);
        await expect(sql`SELECT 2`).rejects.toThrow(/session setting failed/);
    });

    it("keeps live notifications that arrive together with the registration reply", async () => {
        FakeSocket.reset((socket, m) => {
            if (m.method === "live") {
                socket.reply({ result: { action: "CREATE", id: "q-9", result: { n: 1 } } });
                socket.reply({ id: m.id, result: "q-9" });
            } else socket.reply({ id: m.id, result: m.method === "signin" ? "tok" : null });
        });
        const { sql } = client(() => emptyOk("X"), { transport: "ws" });
        const iterator = sql.live<{ n: number }>("person")[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toEqual({
            action: "CREATE",
            id: "q-9",
            result: { n: 1 },
        });
        await iterator.return?.();
    });

    it("does not expose credentials when a client is serialised", () => {
        const { sql } = client(() => emptyOk("X"));
        expect(JSON.stringify(Object.assign({}, sql))).not.toContain("root");
        expect(Object.keys(sql)).not.toContain("config");
    });
});
