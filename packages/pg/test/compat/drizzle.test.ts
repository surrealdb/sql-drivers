import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { bigint, boolean, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "@surrealdb/pg";
import { startEngine } from "./harness";

const users = pgTable("users", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    age: integer("age"),
    active: boolean("active").default(true),
    meta: jsonb("meta"),
    big: bigint("big", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

let ctx: Awaited<ReturnType<typeof startEngine>>;
let pool: Pool;
beforeAll(async () => {
    ctx = await startEngine();
    pool = new Pool(ctx.options);
});
afterAll(async () => {
    await pool.end();
    await ctx.engine.close();
});

describe("drizzle node-postgres on @surrealdb/pg Pool", () => {
    it("detects the Pool by constructor name (survives bundling)", () => {
        expect(pool.constructor.name).toContain("Pool");
    });

    it("creates, inserts with returning, selects with typed columns", async () => {
        const db = drizzle({ client: pool });
        await db.execute(sql`create table users (id serial primary key, name text not null, age integer, active boolean default true, meta jsonb, big bigint, created_at timestamptz default now())`);
        const inserted = await db.insert(users).values([{ name: "Ann", age: 30, meta: { a: [1, 2] }, big: 2n ** 62n }, { name: "Bob" }]).returning();
        expect(inserted).toHaveLength(2);
        expect(inserted[0]).toMatchObject({ id: 1, name: "Ann", age: 30, active: true, meta: { a: [1, 2] }, big: 2n ** 62n });
        expect(inserted[0].createdAt).toBeInstanceOf(Date);
        expect(inserted[1].age).toBeNull();
        const rows = await db.select({ n: users.name, a: users.age }).from(users).where(eq(users.name, "Ann"));
        expect(rows).toEqual([{ n: "Ann", a: 30 }]);
    });

    it("updates and deletes with rowCount", async () => {
        const db = drizzle({ client: pool });
        const updated = await db.update(users).set({ age: 31 }).where(eq(users.name, "Ann")).returning({ id: users.id, age: users.age });
        expect(updated).toEqual([{ id: 1, age: 31 }]);
        const res: any = await db.execute(sql`delete from users where name = 'Bob'`);
        expect(res.rowCount).toBe(1);
        expect(res.command).toBe("DELETE");
    });

    it("commits and rolls back a transaction on one pinned connection, with savepoints", async () => {
        const db = drizzle({ client: pool });
        await db.transaction(async (tx) => {
            await tx.insert(users).values({ name: "T1" });
            await tx.transaction(async (inner) => {
                await inner.insert(users).values({ name: "T2" });
                inner.rollback();
            }).catch(() => {});
        });
        await expect(
            db.transaction(async (tx) => {
                await tx.insert(users).values({ name: "T3" });
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        const names = (await db.select({ n: users.name }).from(users).orderBy(users.id)).map((r) => r.n);
        expect(names).toEqual(["Ann", "T1"]);
        expect(pool.totalCount).toBeGreaterThan(0);
    });

    it("runs a migration folder", async () => {
        const folder = mkdtempSync(join(tmpdir(), "drizzle-"));
        mkdirSync(join(folder, "meta"));
        writeFileSync(join(folder, "0000_init.sql"), "CREATE TABLE migrated (id serial primary key, v text);\n--> statement-breakpoint\nINSERT INTO migrated (v) VALUES ('x');");
        writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1700000000000, tag: "0000_init", breakpoints: true }] }));
        const db = drizzle({ client: pool });
        await migrate(db, { migrationsFolder: folder });
        const r: any = await db.execute(sql`select v from migrated`);
        expect(r.rows).toEqual([{ v: "x" }]);
    });

    it("works with a single Client as well", async () => {
        const client = new Client(ctx.options);
        await client.connect();
        const db = drizzle({ client });
        const rows = await db.select({ n: users.name }).from(users).where(eq(users.id, 1));
        expect(rows).toEqual([{ n: "Ann" }]);
        await client.end();
    });
});
