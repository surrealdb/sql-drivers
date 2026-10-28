import { Client, connect, Pool } from "@surrealdb/pg";
import { FakeSocket, routing } from "@surrealdb/sql-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgliteEngine } from "../../../../test-support/pglite-engine";

let engine: PgliteEngine;
beforeAll(async () => {
    engine = await PgliteEngine.create();
    FakeSocket.reset(routing((m, p) => engine.handle("ws", m, p)));
});
afterAll(() => engine.close());

const opts = () => ({
    connectionString: "postgres://root:root@localhost/app?ns=t",
    WebSocket: FakeSocket as never,
    fetch: engine.fetch,
});

describe("simulator smoke", () => {
    it("native over HTTP", async () => {
        const sql = connect({
            url: "postgres://root:root@localhost/app?ns=t",
            fetch: engine.fetch,
        });
        await sql.execute(
            "create table smoke (id serial primary key, name text, at timestamptz default now())",
        );
        await sql`insert into smoke (name) values (${"a"}), (${"b"})`;
        const rows = await sql`select id, name from smoke order by id`;
        expect(rows).toEqual([
            { id: 1, name: "a" },
            { id: 2, name: "b" },
        ]);
    });

    it("compat Client over the WebSocket", async () => {
        const client = new Client(opts());
        await client.connect();
        const r = (await client.query("select id, name from smoke where id = $1", [2])) as any;
        expect(r.rows).toEqual([{ id: 2, name: "b" }]);
        expect(r.command).toBe("SELECT");
        expect(r.rowCount).toBe(1);
        await client.end();
    });

    it("compat Pool one-shot over HTTP", async () => {
        const pool = new Pool(opts());
        const r = (await pool.query("select count(*)::int as n from smoke")) as any;
        expect(r.rows[0].n).toBe(2);
        await pool.end();
    });
});
