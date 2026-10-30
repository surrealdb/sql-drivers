import { Client, neonConfig, Pool } from "@surrealdb/pg/neon";
import { FakeSocket } from "@surrealdb/sql-internal/testing";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine } from "./harness";

const items = pgTable("items", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    qty: integer("qty"),
});

let ctx: Awaited<ReturnType<typeof startEngine>>;
let pool: Pool;
beforeAll(async () => {
    ctx = await startEngine();
    neonConfig.webSocketConstructor = FakeSocket as never;
    pool = new Pool({ connectionString: ctx.options.connectionString, fetch: ctx.options.fetch });
});
afterAll(async () => {
    neonConfig.webSocketConstructor = undefined;
    await pool.end();
    await ctx.engine.close();
});

describe("drizzle neon-serverless on the Pool of @surrealdb/pg/neon", () => {
    it("takes the WebSocket class from neonConfig", async () => {
        const client = await pool.connect();
        expect(client).toBeInstanceOf(Client);
        expect(client.config.WebSocket).toBe(FakeSocket);
        client.release();
    });

    it("creates, inserts with returning, selects, updates", async () => {
        const db = drizzle({ client: pool as never });
        await db.execute(
            sql`create table items (id serial primary key, name text not null, qty integer)`,
        );
        const inserted = await db
            .insert(items)
            .values([{ name: "a", qty: 2 }, { name: "b" }])
            .returning();
        expect(inserted).toEqual([
            { id: 1, name: "a", qty: 2 },
            { id: 2, name: "b", qty: null },
        ]);
        const updated = await db
            .update(items)
            .set({ qty: 9 })
            .where(eq(items.name, "b"))
            .returning({ q: items.qty });
        expect(updated).toEqual([{ q: 9 }]);
    });

    it("commits and rolls back interactive transactions on one pinned session", async () => {
        const db = drizzle({ client: pool as never });
        await db.transaction(async (tx) => {
            await tx.insert(items).values({ name: "t1" });
        });
        await expect(
            db.transaction(async (tx) => {
                await tx.insert(items).values({ name: "t2" });
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        const names = (await db.select({ n: items.name }).from(items).orderBy(items.id)).map(
            (r) => r.n,
        );
        expect(names).toEqual(["a", "b", "t1"]);
    });
});
