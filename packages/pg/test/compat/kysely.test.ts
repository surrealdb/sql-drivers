import { Kysely, PostgresDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "@surrealdb/pg";
import { startEngine } from "./harness";

interface DB {
    pet: { id: number; name: string; owner: string | null };
}

let ctx: Awaited<ReturnType<typeof startEngine>>;
let db: Kysely<DB>;
beforeAll(async () => {
    ctx = await startEngine();
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool(ctx.options) as never }) });
});
afterAll(async () => {
    await db.destroy();
    await ctx.engine.close();
});

describe("kysely PostgresDialect on @surrealdb/pg Pool", () => {
    it("creates a table, inserts with returning, selects", async () => {
        await db.schema.createTable("pet").addColumn("id", "serial", (c) => c.primaryKey()).addColumn("name", "text", (c) => c.notNull()).addColumn("owner", "text").execute();
        const rows = await db.insertInto("pet").values([{ name: "Rex", owner: "a" }, { name: "Tom", owner: null }]).returningAll().execute();
        expect(rows).toEqual([{ id: 1, name: "Rex", owner: "a" }, { id: 2, name: "Tom", owner: null }]);
        expect(await db.selectFrom("pet").select("name").where("owner", "=", "a").execute()).toEqual([{ name: "Rex" }]);
    });

    it("reports affected rows from the command", async () => {
        const res = await db.updateTable("pet").set({ owner: "b" }).where("name", "=", "Tom").executeTakeFirst();
        expect(res.numUpdatedRows).toBe(1n);
        const del = await db.deleteFrom("pet").where("name", "=", "nobody").executeTakeFirst();
        expect(del.numDeletedRows).toBe(0n);
    });

    it("commits and rolls back transactions, with isolation", async () => {
        await db.transaction().setIsolationLevel("serializable").execute(async (trx) => {
            await trx.insertInto("pet").values({ name: "Kept", owner: "c" }).execute();
        });
        await expect(
            db.transaction().execute(async (trx) => {
                await trx.insertInto("pet").values({ name: "Lost", owner: "c" }).execute();
                throw new Error("nope");
            }),
        ).rejects.toThrow("nope");
        const names = (await db.selectFrom("pet").select("name").orderBy("id").execute()).map((r) => r.name);
        expect(names).toEqual(["Rex", "Tom", "Kept"]);
    });

    it("runs raw sql with parameters", async () => {
        const r = await sql<{ n: number }>`select ${5}::int as n`.execute(db);
        expect(r.rows).toEqual([{ n: 5 }]);
    });
});
