import { connect, createPool, type Pool } from "@surrealdb/mysql";
import { createPool as createCallbackPool } from "@surrealdb/mysql/callback";
import { eq, sql } from "drizzle-orm";
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import { Kysely, sql as ksql, MysqlDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

const items = mysqlTable("m_items", {
    id: int("id").primaryKey(),
    name: varchar("name", { length: 50 }).notNull(),
    qty: int("qty"),
});

/** The real adapter code against a real server. */
describe.skipIf(!binary)("mysql adapters against a server", () => {
    let server: RunningServer;
    const uri = () => `surrealdb+http://root:root@${server.host}/test/madapters`;

    beforeAll(async () => {
        server = await startServer(binary as string);
        const setup = connect({ url: `surrealdb+http://root:root@${server.host}/test/test` });
        await setup.surql`DEFINE DATABASE IF NOT EXISTS madapters`;
        await setup.close();
    }, 60_000);
    afterAll(async () => {
        await server?.stop();
    });

    describe("drizzle mysql2", () => {
        let pool: Pool;
        beforeAll(async () => {
            pool = createPool({ uri: uri() });
            const db = drizzle(pool as never, { mode: "default" });
            await db.execute(
                sql`create table m_items (id int primary key, name varchar(50) not null, qty int)`,
            );
        });
        afterAll(() => pool.end());

        it("inserts, selects, updates and deletes", async () => {
            const db = drizzle(pool as never, { mode: "default" });
            await db.insert(items).values([
                { id: 1, name: "a", qty: 5 },
                { id: 2, name: "b", qty: null },
            ]);
            expect(await db.select().from(items).orderBy(items.id)).toEqual([
                { id: 1, name: "a", qty: 5 },
                { id: 2, name: "b", qty: null },
            ]);
            await db.update(items).set({ qty: 9 }).where(eq(items.id, 1));
            expect(await db.select({ q: items.qty }).from(items).where(eq(items.id, 1))).toEqual([
                { q: 9 },
            ]);
            await db.delete(items).where(eq(items.id, 2));
            expect(await db.select({ id: items.id }).from(items)).toEqual([{ id: 1 }]);
        });

        it("commits and rolls back a transaction", async () => {
            const db = drizzle(pool as never, { mode: "default" });
            await db.transaction(async (tx) => {
                await tx.insert(items).values({ id: 10, name: "t1", qty: 1 });
            });
            await expect(
                db.transaction(async (tx) => {
                    await tx.insert(items).values({ id: 11, name: "t2", qty: 1 });
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");
            const ids = (await db.select({ id: items.id }).from(items))
                .map((r) => r.id)
                .sort((a, b) => a - b);
            expect(ids).toEqual([1, 10]);
        });
    });

    describe("kysely MysqlDialect", () => {
        interface DB {
            m_pet: { id: number; name: string };
        }
        let db: Kysely<DB>;
        beforeAll(async () => {
            db = new Kysely<DB>({
                dialect: new MysqlDialect({ pool: createCallbackPool({ uri: uri() }) as never }),
            });
            await ksql`create table m_pet (id int primary key, name varchar(50) not null)`.execute(
                db,
            );
        });
        afterAll(() => db.destroy());

        it("inserts and selects", async () => {
            await db
                .insertInto("m_pet")
                .values([
                    { id: 1, name: "Rex" },
                    { id: 2, name: "Tom" },
                ])
                .execute();
            expect(await db.selectFrom("m_pet").selectAll().orderBy("id").execute()).toEqual([
                { id: 1, name: "Rex" },
                { id: 2, name: "Tom" },
            ]);
            const res = await db
                .updateTable("m_pet")
                .set({ name: "Max" })
                .where("id", "=", 1)
                .executeTakeFirst();
            expect(res.numUpdatedRows).toBe(1n);
        });
    });
});
