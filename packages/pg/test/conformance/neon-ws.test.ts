/**
 * `Pool` and `Client` of `@neondatabase/serverless` (the PostgreSQL wire protocol over a
 * WebSocket to a PGlite proxy) against the same of `@surrealdb/pg/neon` (the `pgsql` contract
 * over a WebSocket to the simulator). The same node-postgres style cases run on both.
 */
import { FakeSocket, routing } from "@surrealdb/sql-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type PgWireBridge, startPgWireBridge } from "../../../../test-support/pg-wire-bridge";
import { PgliteEngine } from "../../../../test-support/pglite-engine";
import { type Subject, subjects, URL } from "./subjects";

describe.each(subjects)("neon WebSocket Pool and Client: $name", (subject: Subject) => {
    let bridge: PgWireBridge | undefined;
    let engine: PgliteEngine | undefined;
    let cs: string;
    let pool: any;
    // this package's pool runs statements it does not pin over HTTP, so it needs a `fetch`
    let extra: Record<string, unknown> = {};

    beforeAll(async () => {
        const { neonConfig } = subject.lib;
        if (subject.name === "vendor") {
            bridge = await startPgWireBridge();
            neonConfig.webSocketConstructor = WebSocket as never;
            neonConfig.wsProxy = () => bridge?.proxy as string;
            neonConfig.useSecureWebSocket = false;
            neonConfig.pipelineConnect = false;
            cs = "postgres://root:root@localhost/app";
        } else {
            engine = await PgliteEngine.create();
            FakeSocket.reset(routing((m, p) => (engine as PgliteEngine).handle("ws", m, p)));
            neonConfig.webSocketConstructor = FakeSocket as never;
            cs = URL;
            extra = { fetch: engine.fetch };
        }
        pool = new subject.lib.Pool({ connectionString: cs, max: 2, ...extra });
        await pool.query(
            "create table things (id serial primary key, name text not null, n int, at timestamptz, meta jsonb)",
        );
    });
    afterAll(async () => {
        await pool?.end();
        await bridge?.close();
        await engine?.close();
        subject.lib.neonConfig.webSocketConstructor = undefined;
    });

    it("Pool.query returns a pg result with rows, fields, rowCount and command", async () => {
        const insert = await pool.query("insert into things (name, n) values ($1, $2), ($3, $4)", [
            "a",
            1,
            "b",
            2,
        ]);
        expect(insert.command).toBe("INSERT");
        expect(insert.rowCount).toBe(2);
        const r = await pool.query("select id, name, n from things order by id");
        expect(r.command).toBe("SELECT");
        expect(r.rowCount).toBe(2);
        expect(r.rows).toEqual([
            { id: 1, name: "a", n: 1 },
            { id: 2, name: "b", n: 2 },
        ]);
        expect(r.fields.map((f: any) => f.name)).toEqual(["id", "name", "n"]);
        expect(r.fields.map((f: any) => f.dataTypeID)).toEqual([23, 25, 23]);
    });

    it("supports query config objects and rowMode: 'array'", async () => {
        const r = await pool.query({
            text: "select id, name from things where id = $1",
            values: [1],
            rowMode: "array",
        });
        expect(r.rows).toEqual([[1, "a"]]);
    });

    it("parses timestamps, json and bigint like node-postgres", async () => {
        await pool.query("insert into things (name, at, meta) values ($1, $2, $3)", [
            "c",
            new Date("2020-01-02T03:04:05Z"),
            { a: 1 },
        ]);
        const r = await pool.query(
            "select at, meta, 9007199254740993::bigint as big from things where name = 'c'",
        );
        expect(r.rows[0].at).toBeInstanceOf(Date);
        expect(r.rows[0].meta).toEqual({ a: 1 });
        expect(r.rows[0].big).toBe("9007199254740993");
    });

    it("custom types per query replace a parser", async () => {
        const r = await pool.query({
            text: "select 5::int as n",
            types: { getTypeParser: () => (v: string) => `x${v}` },
        });
        expect(r.rows).toEqual([{ n: "x5" }]);
    });

    it("errors are DatabaseError with code, severity and message", async () => {
        const error: any = await pool.query("select * from missing").catch((e: Error) => e);
        expect(error).toBeInstanceOf(subject.lib.DatabaseError);
        expect(error.code).toBe("42P01");
        expect(error.severity).toBe("ERROR");
        expect(error.message).toMatch(/missing/);
    });

    it("connect() gives a client that pins a transaction and release() returns it", async () => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("insert into things (name) values ('tx')");
            await client.query("ROLLBACK");
        } finally {
            client.release();
        }
        const r = await pool.query("select count(*)::int as c from things where name = 'tx'");
        expect(r.rows[0].c).toBe(0);
    });

    it("commits a pinned transaction", async () => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("insert into things (name) values ('kept')");
            await client.query("COMMIT");
        } finally {
            client.release();
        }
        const r = await pool.query("select name from things where name = 'kept'");
        expect(r.rows).toHaveLength(1);
    });

    it("a standalone Client connects, queries and ends", async () => {
        // a PGlite proxy serves one active connection, so the vendor gets one of its own
        const own = subject.name === "vendor" ? await startPgWireBridge() : undefined;
        const previous = subject.lib.neonConfig.wsProxy;
        if (own) subject.lib.neonConfig.wsProxy = () => own.proxy;
        try {
            const client = new subject.lib.Client({ connectionString: cs, ...extra });
            await client.connect();
            const r = await client.query("select 1 as one");
            expect(r.rows).toEqual([{ one: 1 }]);
            await client.end();
        } finally {
            subject.lib.neonConfig.wsProxy = previous;
            await own?.close();
        }
    });

    it("Pool reports totalCount, idleCount and waitingCount", async () => {
        expect(typeof pool.totalCount).toBe("number");
        expect(typeof pool.idleCount).toBe("number");
        expect(typeof pool.waitingCount).toBe("number");
    });

    it("Pool emits connect when it opens a client", async () => {
        const p = new subject.lib.Pool({ connectionString: cs, max: 1, ...extra });
        let connected = 0;
        p.on("connect", () => connected++);
        // `query` on this package's pool runs over HTTP without opening a client, so check out one
        (await p.connect()).release();
        expect(connected).toBe(1);
        await p.end();
    });

    it("takes a callback in place of returning a promise", async () => {
        const result: any = await new Promise((resolve, reject) =>
            pool.query("select 1 as one", (error: Error | null, r: unknown) =>
                error ? reject(error) : resolve(r),
            ),
        );
        expect(result.rows).toEqual([{ one: 1 }]);
    });

    it("accepts a prepared statement name and a queryMode", async () => {
        const named = await pool.query({
            name: "by-id",
            text: "select name from things where id = $1",
            values: [1],
        });
        expect(named.rows).toEqual([{ name: "a" }]);
        const simple = await pool.query({ text: "select 2 as two", queryMode: "simple" });
        expect(simple.rows).toEqual([{ two: 2 }]);
    });

    it("a simple query with several statements returns one result for each", async () => {
        const client = await pool.connect();
        try {
            const results = await client.query("select 1 as a; select 2 as b");
            expect(Array.isArray(results)).toBe(true);
            expect(results.map((r: any) => r.rows)).toEqual([[{ a: 1 }], [{ b: 2 }]]);
        } finally {
            client.release();
        }
    });

    it("a client has its own neonConfig falling back to the global one", async () => {
        const client = new subject.lib.Client({ connectionString: cs, ...extra }) as any;
        expect(client.neonConfig).toBeDefined();
        expect(client.neonConfig.useSecureWebSocket).toBe(
            subject.lib.neonConfig.useSecureWebSocket,
        );
    });

    it("Pool is an instance of the Client it builds from", async () => {
        const client = await pool.connect();
        expect(client).toBeInstanceOf(subject.lib.Client);
        client.release();
    });
});
