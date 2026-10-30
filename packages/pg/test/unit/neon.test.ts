import {
    Client,
    DatabaseError,
    NeonDbError,
    NeonQueryPromise,
    neon,
    neonConfig,
    Pool,
    types,
    UnsupportedOnTransportError,
} from "@surrealdb/pg/neon";
import {
    emptyOk,
    FakeSocket,
    selectPersonPg,
    statementErrorPg,
} from "@surrealdb/sql-internal/testing";
import { afterEach, describe, expect, it } from "vitest";

type Body = { method: string; params: any[] };

function setup(reply: (body: Body) => unknown = () => selectPersonPg) {
    const calls: { url: string; init: RequestInit; body: Body }[] = [];
    const fetchFunction = (async (url: string, init: RequestInit) => {
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
        const body = JSON.parse(String(init.body)) as Body;
        calls.push({ url, init, body });
        return new Response(JSON.stringify({ id: 1, result: reply(body) }), {
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    return { calls, fetchFunction };
}

const URL = "postgres://root:root@localhost/app?ns=prod";

afterEach(() => {
    neonConfig.fetchFunction = undefined;
    neonConfig.fetchEndpoint = undefined;
    neonConfig.webSocketConstructor = undefined;
});

describe("neon() queries", () => {
    it("runs a tagged template with $n placeholders and returns object rows", async () => {
        const { calls, fetchFunction } = setup();
        const sql = neon(URL, { fetchFunction });
        const rows = await sql`SELECT id, name FROM person WHERE name = ${"Tobie"} AND age > ${3}`;
        expect(rows).toEqual([{ id: "person:tobie", name: "Tobie" }]);
        expect(calls[0].body).toEqual({
            id: 1,
            method: "pgsql",
            params: [
                "SELECT id, name FROM person WHERE name = $1 AND age > $2",
                { _1: "Tobie", _2: 3 },
                { rowMode: "array", valueMode: "text" },
            ],
        });
        expect((calls[0].init.headers as Record<string, string>)["Surreal-NS"]).toBe("prod");
        expect((calls[0].init.headers as Record<string, string>)["Surreal-DB"]).toBe("app");
        expect((calls[0].init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    });

    it("is lazy: nothing is sent until awaited, and it is sent once", async () => {
        const { calls, fetchFunction } = setup();
        const sql = neon(URL, { fetchFunction });
        const q = sql`SELECT 1`;
        expect(q).toBeInstanceOf(NeonQueryPromise);
        expect(calls).toHaveLength(0);
        await q;
        await q.then((r) => r);
        expect(calls).toHaveLength(1);
    });

    it("rejects the plain function form", () => {
        const sql = neon(URL, { fetchFunction: setup().fetchFunction });
        expect(() => (sql as any)("SELECT $1", [1])).toThrow(/sql\.query/);
    });

    it("supports sql.query with arrayMode and fullResults", async () => {
        const { fetchFunction } = setup();
        const sql = neon(URL, { fetchFunction });
        const rows = await sql.query("SELECT id, name FROM person", [], { arrayMode: true });
        expect(rows).toEqual([["person:tobie", "Tobie"]]);
        const full = await sql.query("SELECT id, name FROM person", [], { fullResults: true });
        expect(full).toMatchObject({
            command: "SELECT",
            rowCount: 1,
            rowAsArray: false,
            viaNeonFetch: true,
            rows: [{ id: "person:tobie", name: "Tobie" }],
        });
        expect(full.fields.map((f) => [f.name, f.dataTypeID])).toEqual([
            ["id", 25],
            ["name", 25],
        ]);
    });

    it("takes arrayMode and fullResults from the neon() options", async () => {
        const { fetchFunction } = setup();
        const sql = neon(URL, { fetchFunction, arrayMode: true, fullResults: true });
        const r = await sql`SELECT id, name FROM person`;
        expect(r.rowAsArray).toBe(true);
        expect(r.rows).toEqual([["person:tobie", "Tobie"]]);
    });

    it("splices sql.unsafe text and numbers the other values", async () => {
        const { calls, fetchFunction } = setup();
        const sql = neon(URL, { fetchFunction });
        await sql`SELECT * FROM person ORDER BY ${sql.unsafe("name DESC")} LIMIT ${5}`;
        expect(calls[0].body.params[0]).toBe("SELECT * FROM person ORDER BY name DESC LIMIT $1");
        expect(calls[0].body.params[1]).toEqual({ _1: 5 });
    });

    it("raises a NeonDbError carrying the sqlstate, severity and position", async () => {
        const { fetchFunction } = setup(() => statementErrorPg);
        const sql = neon(URL, { fetchFunction });
        const error: any = await sql`SELECT * FROM nope`.catch((e) => e);
        expect(error).toBeInstanceOf(NeonDbError);
        expect(error).toBeInstanceOf(DatabaseError);
        expect(error).toMatchObject({
            name: "NeonDbError",
            code: "42P01",
            severity: "ERROR",
            position: "15",
        });
    });

    it("applies the pg type parsers, as the Neon driver does", async () => {
        const { fetchFunction } = setup(() => ({
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
                        {
                            name: "n",
                            type: { name: "int4", oid: 23 },
                            nullable: null,
                            table: null,
                            column: null,
                        },
                        {
                            name: "at",
                            type: { name: "timestamptz", oid: 1184 },
                            nullable: null,
                            table: null,
                            column: null,
                        },
                    ],
                    rows: [["7", "2026-01-02 03:04:05+00"]],
                },
            ],
            transaction: { status: "idle" },
        }));
        const sql = neon(URL, { fetchFunction });
        const [row] = await sql`SELECT 1`;
        expect(row.n).toBe(7);
        expect(row.at).toBeInstanceOf(Date);
        expect(typeof types.getTypeParser(23)).toBe("function");
    });

    it("sends a bearer token from authToken, per call or per function", async () => {
        const { calls, fetchFunction } = setup();
        const sql = neon("postgres://localhost/app?ns=prod", { fetchFunction, authToken: "A" });
        await sql`SELECT 1`;
        await sql.query("SELECT 1", [], { authToken: "B" });
        await sql.query("SELECT 1", [], { authToken: async () => "C" });
        const auth = calls.map((c) => (c.init.headers as Record<string, string>).Authorization);
        expect(auth).toEqual(["Bearer A", "Bearer B", "Bearer C"]);
    });

    it("merges fetchOptions into the request and honours its signal", async () => {
        const { calls, fetchFunction } = setup();
        const sql = neon(URL, { fetchFunction });
        await sql.query("SELECT 1", [], {
            fetchOptions: { priority: "high", headers: { "x-test": "1" } },
        });
        expect((calls[0].init as any).priority).toBe("high");
        expect((calls[0].init.headers as Record<string, string>)["x-test"]).toBe("1");
        const controller = new AbortController();
        controller.abort();
        await expect(
            sql.query("SELECT 1", [], { fetchOptions: { signal: controller.signal } }),
        ).rejects.toThrow();
    });

    it("reads neonConfig.fetchFunction and fetchEndpoint at call time", async () => {
        const { calls, fetchFunction } = setup();
        neonConfig.fetchFunction = fetchFunction;
        neonConfig.fetchEndpoint = (host, port) => `https://proxy.example/${host}/${port}/rpc`;
        const sql = neon("postgres://root:root@db.example/app?ns=prod");
        await sql`SELECT 1`;
        expect(calls[0].url).toBe("https://proxy.example/db.example/443/rpc");
        neonConfig.fetchEndpoint = "https://fixed.example/rpc";
        await sql`SELECT 1`;
        expect(calls[1].url).toBe("https://fixed.example/rpc");
    });

    it("works when called detached, as Drizzle calls sql.query", async () => {
        const { fetchFunction } = setup();
        const sql = neon(URL, { fetchFunction });
        const { query } = sql;
        expect(await query("SELECT 1", [], { arrayMode: true, fullResults: true })).toMatchObject({
            rowAsArray: true,
        });
    });

    it("needs a connection string and validates its scheme", () => {
        expect(() => neon("mysql://localhost/app")).toThrow(/scheme/);
    });
});

describe("neon() transactions", () => {
    const two = (body: Body) => ({
        statements: [...emptyOk("INSERT 0 1", 1).statements, ...selectPersonPg.statements],
        transaction: { status: "idle", committed: true },
        _: body,
    });

    it("sends all queries in one atomic call and returns one result each", async () => {
        const { calls, fetchFunction } = setup(two);
        const sql = neon(URL, { fetchFunction });
        const results = await sql.transaction([
            sql`INSERT INTO person (name) VALUES (${"a"})`,
            sql.query("SELECT id, name FROM person WHERE name = $1", ["a"]),
        ]);
        expect(calls).toHaveLength(1);
        expect(calls[0].body.params).toEqual([
            [
                { text: "INSERT INTO person (name) VALUES ($1)", vars: { _1: "a" } },
                { text: "SELECT id, name FROM person WHERE name = $1", vars: { _1: "a" } },
            ],
            null,
            { rowMode: "array", valueMode: "text", atomic: true },
        ]);
        expect(results[0]).toEqual([]);
        expect(results[1]).toEqual([{ id: "person:tobie", name: "Tobie" }]);
    });

    it("accepts a function of a query builder and per-query options", async () => {
        const { fetchFunction } = setup(two);
        const sql = neon(URL, { fetchFunction });
        const results = await sql.transaction(
            (txn) => [
                txn`INSERT INTO person (name) VALUES (${"a"})`,
                txn.query("SELECT 1", [], { fullResults: true }),
            ],
            { arrayMode: true },
        );
        expect(results[1]).toMatchObject({ command: "SELECT", rowAsArray: true });
    });

    it("raises the first failed statement as a NeonDbError", async () => {
        const { fetchFunction } = setup(() => statementErrorPg);
        const sql = neon(URL, { fetchFunction });
        await expect(sql.transaction([sql`SELECT 1`])).rejects.toBeInstanceOf(NeonDbError);
    });

    it("sends the isolation level and access mode of the transaction with the atomic call", async () => {
        const { calls, fetchFunction } = setup(two);
        const sql = neon(URL, { fetchFunction });
        await sql.transaction([sql`SELECT 1`, sql`SELECT 2`], {
            isolationLevel: "RepeatableRead",
            readOnly: true,
        });
        const options = (calls[0].body as { params: unknown[] }).params[2] as Record<
            string,
            unknown
        >;
        expect(options).toMatchObject({
            atomic: true,
            isolation: "repeatable read",
            readOnly: true,
        });
        await sql.transaction([sql`SELECT 1`, sql`SELECT 2`], { isolationLevel: "Serializable" });
        const second = (calls[1].body as { params: unknown[] }).params[2] as Record<
            string,
            unknown
        >;
        expect(second.isolation).toBe("serializable");
        expect(second.readOnly).toBeUndefined();
    });

    it("refuses an unknown isolation level before sending anything", async () => {
        const { calls, fetchFunction } = setup(two);
        const sql = neon(URL, { fetchFunction });
        await expect(
            sql.transaction([sql`SELECT 1`], { isolationLevel: "Bogus" as never }),
        ).rejects.toBeInstanceOf(TypeError);
        expect(calls).toHaveLength(0);
    });

    it("rejects values which are not queries and returns nothing for no queries", async () => {
        const { calls, fetchFunction } = setup(two);
        const sql = neon(URL, { fetchFunction });
        await expect(sql.transaction([Promise.resolve(1)] as never)).rejects.toThrow(TypeError);
        expect(await sql.transaction([])).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it("fails when the result count does not match the queries", async () => {
        const { fetchFunction } = setup(() => emptyOk("SELECT 0"));
        const sql = neon(URL, { fetchFunction });
        await expect(sql.transaction([sql`SELECT 1`, sql`SELECT 2`])).rejects.toThrow(/results/);
    });
});

describe("neon exports", () => {
    it("builds the WebSocket client with neonConfig.webSocketConstructor", async () => {
        neonConfig.webSocketConstructor = FakeSocket as never;
        const client = new Client("postgres://root:root@localhost/app?ns=t");
        expect(client.config.WebSocket).toBe(FakeSocket);
        const pool = new Pool("postgres://root:root@localhost/app?ns=t");
        expect(pool.options.Client).toBe(Client);
        expect(pool.options.WebSocket).toBe(FakeSocket);
        await pool.end();
    });

    it("keeps an explicit WebSocket over the global setting", () => {
        neonConfig.webSocketConstructor = FakeSocket as never;
        class Other extends FakeSocket {}
        const client = new Client({
            connectionString: "postgres://localhost/app",
            WebSocket: Other as never,
        });
        expect(client.config.WebSocket).toBe(Other);
    });
});
