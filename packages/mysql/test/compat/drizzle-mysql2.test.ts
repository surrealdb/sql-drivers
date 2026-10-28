import { createPool, type Pool } from "@surrealdb/mysql";
import { FakeSocket, routing } from "@surrealdb/sql-internal/testing";
import { eq, sql } from "drizzle-orm";
import { datetime, int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteMysqlEngine } from "../../../../test-support/sqlite-mysql-engine";

const items = mysqlTable("items", {
    id: int("id").primaryKey(),
    name: varchar("name", { length: 50 }).notNull(),
    note: text("note"),
    at: datetime("at", { mode: "date" }),
});

let engine: SqliteMysqlEngine;
let pool: Pool;
beforeAll(() => {
    engine = new SqliteMysqlEngine();
    FakeSocket.reset(routing((m, p) => engine.handle("ws", m, p)));
    pool = createPool({
        uri: "mysql://root:root@localhost/app?ns=t",
        WebSocket: FakeSocket as never,
        fetch: engine.fetch,
    });
});
afterAll(async () => {
    await pool.end();
    engine.close();
});

describe("drizzle mysql2 on @surrealdb/mysql", () => {
    it("inserts and selects with typed columns and datetime via typeCast", async () => {
        const db = drizzle(pool as never, { mode: "default" });
        await db.execute(
            sql`create table items (id integer primary key, name text not null, note text, at datetime)`,
        );
        const when = new Date(2026, 0, 2, 3, 4, 5);
        const [header] = await db.insert(items).values([
            { id: 1, name: "a", note: null, at: when },
            { id: 2, name: "b", note: null, at: null },
        ]);
        expect(header.affectedRows).toBe(2);
        const rows = await db.select().from(items).orderBy(items.id);
        expect(rows[0]).toMatchObject({ id: 1, name: "a", note: null });
        expect(rows[0].at).toEqual(when);
        expect(rows[1].at).toBeNull();
    });

    it("updates, deletes and reads affected rows", async () => {
        const db = drizzle(pool as never, { mode: "default" });
        const [upd] = await db.update(items).set({ name: "z" }).where(eq(items.id, 1));
        expect(upd.affectedRows).toBe(1);
        const [del] = await db.delete(items).where(eq(items.id, 2));
        expect(del.affectedRows).toBe(1);
        expect(await db.select({ n: items.name }).from(items)).toEqual([{ n: "z" }]);
    });

    it("uses execute() for raw all() queries", async () => {
        const db = drizzle(pool as never, { mode: "default" });
        const res = await db.execute(sql`select count(*) as n from items`);
        expect((res as any)[0][0].n).toBe(1);
    });

    it("runs a transaction on one pinned connection and rolls back on error", async () => {
        const db = drizzle(pool as never, { mode: "default" });
        await db.transaction(async (tx) => {
            await tx.insert(items).values({ id: 10, name: "t1", note: null, at: null });
        });
        await expect(
            db.transaction(async (tx) => {
                await tx.insert(items).values({ id: 11, name: "t2", note: null, at: null });
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        const ids = (await db.select({ id: items.id }).from(items).orderBy(items.id)).map(
            (r) => r.id,
        );
        expect(ids).toEqual([1, 10]);
    });

    it("surfaces a duplicate key as a mysql2-shaped error", async () => {
        const db = drizzle(pool as never, { mode: "default" });
        const error: any = await db
            .insert(items)
            .values({ id: 1, name: "dup", note: null, at: null })
            .catch((e) => e);
        expect(error.cause?.code ?? error.code).toBe("ER_DUP_ENTRY");
    });
});
