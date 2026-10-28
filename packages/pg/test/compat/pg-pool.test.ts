import { Client as SurrealClient } from "@surrealdb/pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine } from "./harness";

let ctx: Awaited<ReturnType<typeof startEngine>>;
let pool: pg.Pool;
beforeAll(async () => {
    ctx = await startEngine();
    pool = new pg.Pool({ ...ctx.options, Client: SurrealClient as never, max: 2 });
});
afterAll(async () => {
    await pool.end();
    await ctx.engine.close();
});

describe("real pg.Pool with the SurrealDB Client", () => {
    it("is a genuine pg.Pool instance", () => {
        expect(pool instanceof pg.Pool).toBe(true);
    });

    it("runs queries and parses types through pg-types by default", async () => {
        const r = await pool.query(
            "select 1::int4 as a, 't'::bool as b, '{1,2}'::int[] as c, now() as d, 9007199254740993::int8 as e",
        );
        expect(r.rows[0]).toMatchObject({ a: 1, b: true, c: [1, 2], e: "9007199254740993" });
        expect(r.rows[0].d).toBeInstanceOf(Date);
        expect(r.fields.map((f) => f.dataTypeID)).toEqual([23, 16, 1007, 1184, 20]);
    });

    it("honours rowMode array and custom types", async () => {
        const r = await pool.query({
            text: "select 1::int4 as a, 'x'::text as b",
            rowMode: "array",
            types: { getTypeParser: () => (v: string) => `<${v}>` } as never,
        });
        expect(r.rows).toEqual([["<1>", "<x>"]]);
    });

    it("pins a client for a transaction", async () => {
        await pool.query("create table t (v int)");
        const c = await pool.connect();
        await c.query("begin");
        await c.query("insert into t values (1)");
        await c.query("rollback");
        await c.query("begin");
        await c.query("insert into t values (2)");
        await c.query("commit");
        c.release();
        const r = await pool.query("select v from t");
        expect(r.rows).toEqual([{ v: 2 }]);
    });

    it("raises DatabaseError with sqlstate", async () => {
        const error: any = await pool.query("select * from missing_table").catch((e) => e);
        expect(error.code).toBe("42P01");
        expect(error.severity).toBe("ERROR");
        expect(error.message).toMatch(/does not exist/);
    });
});
