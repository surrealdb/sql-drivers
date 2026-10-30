import { Client, connect, Pool } from "@surrealdb/pg";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { type Generated, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

const users = pgTable("d_users", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    age: integer("age"),
    active: boolean("active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/** The real adapter code against a real server. */
describe.skipIf(!binary)("adapters against a server", () => {
    let server: RunningServer;
    const options = () => ({
        connectionString: `surrealdb+http://root:root@${server.host}/test/adapters`,
    });

    beforeAll(async () => {
        server = await startServer(binary as string);
        const setup = connect({ url: `surrealdb+http://root:root@${server.host}/test/test` });
        await setup.surql`DEFINE DATABASE IF NOT EXISTS adapters`;
        await setup.close();
    }, 60_000);
    afterAll(async () => {
        await server?.stop();
    });

    describe("drizzle node-postgres", () => {
        let pool: Pool;
        beforeAll(async () => {
            pool = new Pool(options());
            const db = drizzle({ client: pool as never });
            await db.execute(
                sql`create table d_users (id serial primary key, name text not null, age integer, active boolean default true, created_at timestamptz default now())`,
            );
        });
        afterAll(() => pool.end());

        it("inserts and selects typed columns", async () => {
            const db = drizzle({ client: pool as never });
            await db.insert(users).values([{ name: "Ann", age: 30 }, { name: "Bob" }]);
            const rows = await db.select().from(users).where(eq(users.name, "Ann"));
            expect(rows[0]).toMatchObject({ name: "Ann", age: 30, active: true });
            expect(rows[0].createdAt).toBeInstanceOf(Date);
            const picked = await db
                .select({ n: users.name, a: users.age })
                .from(users)
                .orderBy(users.id);
            expect(picked).toEqual([
                { n: "Ann", a: 30 },
                { n: "Bob", a: null },
            ]);
        });

        // Known engine issue: RETURNING lists its columns in name order rather than projection
        // order, and text-mode integers carry a sized-number suffix such as "30i32". Drizzle reads
        // RETURNING rows by position, so it maps them wrongly until the engine is fixed.
        it.fails("reads RETURNING rows by projection order", async () => {
            const db = drizzle({ client: pool as never });
            const inserted = await db.insert(users).values({ name: "Ret", age: 1 }).returning();
            expect(inserted[0]).toMatchObject({ name: "Ret", age: 1, active: true });
        });

        it("updates and deletes", async () => {
            const db = drizzle({ client: pool as never });
            await db.update(users).set({ age: 31 }).where(eq(users.name, "Ann"));
            const after = await db
                .select({ age: users.age })
                .from(users)
                .where(eq(users.name, "Ann"));
            expect(after).toEqual([{ age: 31 }]);
            const res: any = await db.execute(sql`delete from d_users where name = 'Bob'`);
            expect(res.rowCount).toBe(1);
        });

        it("commits and rolls back a transaction", async () => {
            const db = drizzle({ client: pool as never });
            await db.transaction(async (tx) => {
                await tx.insert(users).values({ name: "T1" });
            });
            await expect(
                db.transaction(async (tx) => {
                    await tx.insert(users).values({ name: "T2" });
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");
            const names = (await db.select({ n: users.name }).from(users)).map((r) => r.n).sort();
            expect(names).toEqual(expect.arrayContaining(["Ann", "T1"]));
            expect(names).not.toContain("T2");
            expect(names).not.toContain("T3");
        });
    });

    describe("kysely PostgresDialect", () => {
        interface DB {
            k_pet: { id: Generated<number>; name: string; owner: string | null };
        }
        let db: Kysely<DB>;
        beforeAll(async () => {
            db = new Kysely<DB>({
                dialect: new PostgresDialect({ pool: new Pool(options()) as never }),
            });
            await db.schema
                .createTable("k_pet")
                .addColumn("id", "serial", (c) => c.primaryKey())
                .addColumn("name", "text", (c) => c.notNull())
                .addColumn("owner", "text")
                .execute();
        });
        afterAll(() => db.destroy());

        it("inserts, selects and reports affected rows", async () => {
            const rows = await db
                .insertInto("k_pet")
                .values([
                    { name: "Rex", owner: "a" },
                    { name: "Tom", owner: null },
                ])
                .returningAll()
                .execute();
            expect(rows.map((r) => r.name)).toEqual(["Rex", "Tom"]);
            const res = await db
                .updateTable("k_pet")
                .set({ owner: "b" })
                .where("name", "=", "Tom")
                .executeTakeFirst();
            expect(res.numUpdatedRows).toBe(1n);
        });

        it("honours an isolation level and access mode through the begin method", async () => {
            await db
                .transaction()
                .setIsolationLevel("serializable")
                .execute(async (trx) => {
                    await trx.insertInto("k_pet").values({ name: "Iso", owner: "i" }).execute();
                });
            await expect(
                db
                    .transaction()
                    .setIsolationLevel("repeatable read")
                    .execute(async (trx) => {
                        await trx
                            .insertInto("k_pet")
                            .values({ name: "IsoLost", owner: "i" })
                            .execute();
                        throw new Error("nope");
                    }),
            ).rejects.toThrow("nope");
            const names = (await db.selectFrom("k_pet").select("name").execute()).map(
                (r) => r.name,
            );
            expect(names).toContain("Iso");
            expect(names).not.toContain("IsoLost");
        });

        it("commits and rolls back", async () => {
            await db.transaction().execute(async (trx) => {
                await trx.insertInto("k_pet").values({ name: "Kept", owner: "c" }).execute();
            });
            await expect(
                db.transaction().execute(async (trx) => {
                    await trx.insertInto("k_pet").values({ name: "Lost", owner: "c" }).execute();
                    throw new Error("nope");
                }),
            ).rejects.toThrow("nope");
            const names = (await db.selectFrom("k_pet").select("name").execute())
                .map((r) => r.name)
                .sort();
            expect(names).toEqual(["Iso", "Kept", "Rex", "Tom"]);
        });
    });

    describe("real pg.Pool with the SurrealDB Client", () => {
        let pool: pg.Pool;
        beforeAll(() => {
            pool = new pg.Pool({ ...options(), Client: Client as never, max: 2 });
        });
        afterAll(() => pool.end());

        it("parses types through pg-types and raises SQLSTATE errors", async () => {
            const r = await pool.query("select 1::int4 as a, 't'::bool as b, now() as d");
            expect(r.rows[0].a).toBe(1);
            expect(r.rows[0].b).toBe(true);
            expect(r.rows[0].d).toBeInstanceOf(Date);
            const error: any = await pool.query("select * from missing_table").catch((e) => e);
            expect(error.code).toMatch(/^[0-9A-Z]{5}$/);
        });
    });
});
