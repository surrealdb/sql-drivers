import {
    Client,
    cast,
    connect,
    DatabaseError,
    format,
    UnsupportedOnTransportError,
} from "@surrealdb/mysql/planetscale";
import { answering, FakeSocket } from "@surrealdb/sql-internal/testing";
import { describe, expect, it } from "vitest";

type Body = { method: string; params: any[] };

const column = (name: string, mysql_type: number) => ({
    name,
    type: { name: "text", mysql_type },
    nullable: null,
    table: "t",
    column: name,
});

const selectRows = {
    statements: [
        {
            status: "OK",
            time: "250µs",
            command: { tag: "SELECT", rows_affected: 2, last_insert_id: null, warnings: 0 },
            columns: [column("id", 3), column("big", 8), column("at", 12), column("doc", 245)],
            rows: [
                [1, "9007199254740993", "2026-01-02 03:04:05", '{"a":1}'],
                [2, null, null, null],
            ],
        },
    ],
    transaction: { status: "idle" },
};

const insertOk = {
    statements: [
        {
            status: "OK",
            time: "1ms",
            command: { tag: "INSERT", rows_affected: 1, last_insert_id: 42, warnings: 0 },
        },
    ],
    transaction: { status: "idle" },
};

function setup(reply: (body: Body) => unknown = () => selectRows) {
    const calls: Body[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Body;
        calls.push(body);
        return new Response(JSON.stringify({ id: 1, result: reply(body) }), {
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    return { calls, fetch: fetchImpl };
}

const config = (fetch: typeof globalThis.fetch, extra = {}) => ({
    host: "localhost",
    username: "root",
    password: "root",
    namespace: "t",
    database: "app",
    fetch,
    ...extra,
});

describe("execute", () => {
    it("binds positional arguments and returns the ExecutedQuery shape", async () => {
        const { calls, fetch } = setup();
        const conn = connect(config(fetch));
        const r = await conn.execute("SELECT * FROM t WHERE id > ? AND at < ?", [0, "x"]);
        expect(calls[0].params[0]).toBe("SELECT * FROM t WHERE id > ? AND at < ?");
        expect(calls[0].params[1]).toEqual({ _1: 0, _2: "x" });
        expect(r.headers).toEqual(["id", "big", "at", "doc"]);
        expect(r.types).toEqual({ id: "INT32", big: "INT64", at: "DATETIME", doc: "JSON" });
        expect(r.fields[0]).toMatchObject({ name: "id", type: "INT32", table: "t", orgName: "id" });
        expect(r.rows).toEqual([
            { id: 1, big: "9007199254740993", at: "2026-01-02 03:04:05", doc: { a: 1 } },
            { id: 2, big: null, at: null, doc: null },
        ]);
        expect(r).toMatchObject({
            rowsAffected: 0,
            insertId: "0",
            size: 2,
            statement: "SELECT * FROM t WHERE id > ? AND at < ?",
        });
        expect(r.time).toBeCloseTo(0.00025, 8);
    });

    it("binds named arguments in order of use, repeats included", async () => {
        const { calls, fetch } = setup();
        const conn = connect(config(fetch));
        await conn.execute("SELECT ':skip', :a, :b, :a FROM t -- :c\n WHERE x = '?'", {
            a: 1,
            b: 2,
        });
        expect(calls[0].params[0]).toBe("SELECT ':skip', ?, ?, ? FROM t -- :c\n WHERE x = '?'");
        expect(calls[0].params[1]).toEqual({ _1: 1, _2: 2, _3: 1 });
    });

    it("expands array arguments, serialises objects and dates, and rejects a missing argument", async () => {
        const { calls, fetch } = setup();
        const conn = connect(config(fetch));
        await conn.execute("SELECT 1 WHERE a IN (?) AND b = ? AND c = ? AND d IN (?)", [
            [1, 2, 3],
            { k: 1 },
            new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)),
            [],
        ]);
        expect(calls[0].params[0]).toBe(
            "SELECT 1 WHERE a IN (?, ?, ?) AND b = ? AND c = ? AND d IN (NULL)",
        );
        expect(calls[0].params[1]).toEqual({
            _1: 1,
            _2: 2,
            _3: 3,
            _4: '{"k":1}',
            _5: "2026-01-02 03:04:05.006",
        });
        await expect(conn.execute("SELECT ?, ?", [1])).rejects.toThrow(/fewer/);
        await expect(conn.execute("SELECT :x", {})).rejects.toThrow(/:x/);
    });

    it("returns array rows with as: 'array' and applies a per-call cast", async () => {
        const { calls, fetch } = setup();
        const conn = connect(config(fetch));
        const r = await conn.execute("SELECT * FROM t", undefined, {
            as: "array",
            cast: (field, value) =>
                field.type === "INT64" && value !== null ? BigInt(value) : cast(field, value),
        });
        expect(r.rows[0]).toEqual([1, 9007199254740993n, "2026-01-02 03:04:05", { a: 1 }]);
        expect((calls[0].params[2] as { rowMode: string }).rowMode).toBe("array");
    });

    it("passes the config cast to every query, and every value to it as text", async () => {
        const { fetch } = setup();
        const seen: unknown[] = [];
        const conn = connect(
            config(fetch, {
                cast: (field: { type: string | null }, value: unknown) => {
                    seen.push(value);
                    return field.type === "INT32" ? `n${value}` : value;
                },
            }),
        );
        const r = await conn.execute("SELECT * FROM t");
        expect(r.rows[0].id).toBe("n1");
        expect(seen[0]).toBe("1");
    });

    it("reports rowsAffected and insertId as text for a write", async () => {
        const { fetch } = setup(() => insertOk);
        const r = await connect(config(fetch)).execute("INSERT INTO t VALUES (?)", [1]);
        expect(r).toMatchObject({
            rowsAffected: 1,
            insertId: "42",
            rows: [],
            size: 0,
            time: 0.001,
        });
    });

    it("uses config.format to render the query on the client", async () => {
        const { calls, fetch } = setup();
        const conn = connect(config(fetch, { format: (q: string) => q.replace("?", "7") }));
        await conn.execute("SELECT ?", [1]);
        expect(calls[0].params[0]).toBe("SELECT 7");
        expect(calls[0].params).toHaveLength(1);
    });

    it("raises a DatabaseError with body, status and the vitess-style code", async () => {
        const { fetch } = setup(() => ({
            statements: [
                {
                    status: "ERR",
                    error: { message: "Duplicate entry '1'", sqlstate: "23000", errno: 1062 },
                },
            ],
            transaction: { status: "idle" },
        }));
        const error: any = await connect(config(fetch))
            .execute("INSERT INTO t VALUES (1)")
            .catch((e) => e);
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error).toMatchObject({
            name: "DatabaseError",
            status: 400,
            body: { code: "ALREADY_EXISTS", message: "Duplicate entry '1'" },
            errno: 1062,
            sqlState: "23000",
        });
    });
});

describe("Client and configuration", () => {
    it("accepts a mysql URL and carries the namespace in ns", async () => {
        const urls: string[] = [];
        const headers: Record<string, string>[] = [];
        const fetchImpl = (async (url: string, init: RequestInit) => {
            urls.push(url);
            headers.push(init.headers as Record<string, string>);
            return new Response(JSON.stringify({ id: 1, result: selectRows }));
        }) as unknown as typeof fetch;
        const client = new Client({ url: "mysql://u:p@db.example/app?ns=prod", fetch: fetchImpl });
        await client.execute("SELECT 1");
        await client.connection().execute("SELECT 1");
        expect(urls[0]).toBe("https://db.example/rpc");
        expect(headers[0]).toMatchObject({ "Surreal-NS": "prod", "Surreal-DB": "app" });
        expect(headers[0].Authorization).toMatch(/^Basic /);
    });

    it("needs a url or a host", () => {
        expect(() => new Client({})).toThrow(/url/);
    });

    it("refreshes without a request", async () => {
        const { calls, fetch } = setup();
        await connect(config(fetch)).refresh();
        expect(calls).toHaveLength(0);
    });
});

describe("transaction", () => {
    it("throws UnsupportedOnTransportError when the transport is pinned to http", async () => {
        const { fetch } = setup();
        const conn = connect(config(fetch, { transport: "http" }));
        await expect(conn.transaction(async () => 1)).rejects.toBeInstanceOf(
            UnsupportedOnTransportError,
        );
    });

    it("runs on a WebSocket session otherwise", async () => {
        const methods: string[] = [];
        FakeSocket.reset(
            answering((method) => {
                methods.push(method);
                return method === "mysql" ? insertOk : null;
            }),
        );
        const { fetch } = setup();
        const conn = connect(config(fetch, { WebSocket: FakeSocket as never }));
        const result = await conn.transaction(async (tx) => {
            const r = await tx.execute("INSERT INTO t VALUES (?)", [1]);
            return r.insertId;
        });
        expect(result).toBe("42");
        expect(methods.filter((m) => m === "mysql")).toHaveLength(3);
    });
});

describe("format", () => {
    it("escapes values into the text", () => {
        expect(
            format("SELECT ?, ?, ?, ?, ?", [null, true, "it's", 3, new Date(Date.UTC(2026, 0, 2))]),
        ).toBe("SELECT NULL, true, 'it\\'s', 3, '2026-01-02 00:00:00.000'");
        expect(format("SELECT :a, :b", { a: [1, "x"], b: { k: 1 } })).toBe(
            "SELECT 1, 'x', '{\\\"k\\\":1}'",
        );
        expect(format("SELECT '?' -- ?\n, ?", ["z"])).toBe("SELECT '?' -- ?\n, 'z'");
        expect(format("SELECT 1")).toBe("SELECT 1");
    });
});

describe("cast", () => {
    const f = (type: string) => ({
        name: "c",
        type,
        table: null,
        orgTable: null,
        database: null,
        orgName: null,
        columnLength: 0,
        charset: null,
        flags: 0,
    });
    it("converts numbers and JSON, and leaves the rest as text", () => {
        expect(cast(f("INT16"), "7")).toBe(7);
        expect(cast(f("FLOAT64"), "1.5")).toBe(1.5);
        expect(cast(f("JSON"), "[1]")).toEqual([1]);
        expect(cast(f("INT64"), "9007199254740993")).toBe("9007199254740993");
        expect(cast(f("DECIMAL"), "1.10")).toBe("1.10");
        expect(cast(f("DATETIME"), "2026-01-01 00:00:00")).toBe("2026-01-01 00:00:00");
        expect(cast(f("INT32"), null)).toBeNull();
    });
});
