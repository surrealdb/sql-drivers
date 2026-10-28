import { createPool } from "@surrealdb/mysql/callback";
import { FakeSocket, routing } from "@surrealdb/sql-internal/testing";
import { type Generated, Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteMysqlEngine } from "../../../../test-support/sqlite-mysql-engine";

interface DB {
    pet: { id: Generated<number>; name: string };
}

let engine: SqliteMysqlEngine;
let db: Kysely<DB>;
beforeAll(() => {
    engine = new SqliteMysqlEngine();
    FakeSocket.reset(routing((m, p) => engine.handle("ws", m, p)));
    const pool = createPool({
        uri: "mysql://root:root@localhost/app?ns=t",
        WebSocket: FakeSocket as never,
        fetch: engine.fetch,
    });
    db = new Kysely<DB>({ dialect: new MysqlDialect({ pool: pool as never }) });
});
afterAll(async () => {
    await db.destroy();
    engine.close();
});

describe("kysely MysqlDialect on the @surrealdb/mysql callback pool", () => {
    it("inserts, reports insertId and affected rows, selects", async () => {
        await sql`create table pet (id integer primary key autoincrement, name text not null)`.execute(
            db,
        );
        const res = await db
            .insertInto("pet")
            .values([{ name: "Rex" }])
            .executeTakeFirst();
        expect(res.insertId).toBe(1n);
        expect(res.numInsertedOrUpdatedRows).toBe(1n);
        await db.insertInto("pet").values({ name: "Tom" }).execute();
        expect(await db.selectFrom("pet").selectAll().orderBy("id").execute()).toEqual([
            { id: 1, name: "Rex" },
            { id: 2, name: "Tom" },
        ]);
        const upd = await db
            .updateTable("pet")
            .set({ name: "Max" })
            .where("id", "=", 1)
            .executeTakeFirst();
        expect(upd.numUpdatedRows).toBe(1n);
    });

    it("commits and rolls back transactions", async () => {
        await db.transaction().execute(async (trx) => {
            await trx.insertInto("pet").values({ name: "Kept" }).execute();
        });
        await expect(
            db.transaction().execute(async (trx) => {
                await trx.insertInto("pet").values({ name: "Lost" }).execute();
                throw new Error("nope");
            }),
        ).rejects.toThrow("nope");
        const names = (await db.selectFrom("pet").select("name").orderBy("id").execute()).map(
            (r) => r.name,
        );
        expect(names).toEqual(["Max", "Tom", "Kept"]);
    });
});
