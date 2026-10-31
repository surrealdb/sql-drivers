import { connect } from "@surrealdb/pg";
import { Client, neon, neonConfig, Pool } from "@surrealdb/pg/neon";
import { eq, sql } from "drizzle-orm";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleSocket } from "drizzle-orm/neon-serverless";
import { boolean, integer, jsonb, pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

const items = pgTable("n_items", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    qty: integer("qty"),
    on: boolean("on").default(true),
    meta: jsonb("meta"),
});

/** Drizzle's neon drivers, which import `@neondatabase/serverless`, on this package's entry point. */
describe.skipIf(!binary)("drizzle neon drivers against a server", () => {
    let server: RunningServer;

    beforeAll(async () => {
        server = await startServer(binary as string);
        const setup = connect({ url: `surrealdb+http://root:root@${server.host}/test/test` });
        await setup.surql`DEFINE DATABASE IF NOT EXISTS neon`;
        await setup.close();
        neonConfig.fetchEndpoint = `http://${server.host}/rpc`;
    }, 60_000);
    afterAll(async () => {
        neonConfig.fetchEndpoint = undefined;
        neonConfig.webSocketConstructor = undefined;
        await server?.stop();
    });

    describe("neon-http over neon()", () => {
        const query = () => neon("postgres://root:root@localhost/neon?ns=test");

        it("creates, inserts with returning, selects, updates and deletes", async () => {
            const db = drizzleHttp(query() as never);
            await db.execute(
                sql`create table n_items (id serial primary key, name text not null, qty integer, "on" boolean default true, meta jsonb)`,
            );
            const inserted = await db
                .insert(items)
                .values([{ name: "a", qty: 2, meta: { k: 1 } }, { name: "b" }])
                .returning();
            expect(inserted).toHaveLength(2);
            expect(inserted[0]).toMatchObject({ name: "a", qty: 2, on: true, meta: { k: 1 } });
            const rows = await db.select({ n: items.name }).from(items).orderBy(items.id);
            expect(rows).toEqual([{ n: "a" }, { n: "b" }]);
            await db.update(items).set({ qty: 5 }).where(eq(items.name, "b"));
            expect(
                await db.select({ q: items.qty }).from(items).where(eq(items.name, "b")),
            ).toEqual([{ q: 5 }]);
            await db.delete(items).where(eq(items.name, "b"));
            expect(await db.select({ n: items.name }).from(items)).toEqual([{ n: "a" }]);
        });

        it("runs db.batch as one atomic call", async () => {
            const db = drizzleHttp(query() as never);
            const [one, two] = await db.batch([
                db.insert(items).values({ name: "batch1" }).returning({ n: items.name }),
                db.select({ n: items.name }).from(items).where(eq(items.name, "batch1")),
            ]);
            expect(one).toEqual([{ n: "batch1" }]);
            expect(two).toEqual([{ n: "batch1" }]);
            await expect(
                db.batch([
                    db.insert(items).values({ name: "batch2" }),
                    db.insert(items).values({ name: null as never }),
                ]),
            ).rejects.toThrow();
            expect(await db.select().from(items).where(eq(items.name, "batch2"))).toEqual([]);
        });
    });

    describe("neon-serverless over Pool", () => {
        let pool: Pool;
        beforeAll(() => {
            neonConfig.webSocketConstructor = WebSocket as never;
            pool = new Pool({
                connectionString: `surrealdb+http://root:root@${server.host}/test/neon`,
            });
        });
        afterAll(() => pool.end());

        it("hands out clients of the Client class", async () => {
            const client = await pool.connect();
            expect(client).toBeInstanceOf(Client);
            client.release();
        });

        it("inserts with returning, selects and updates", async () => {
            const db = drizzleSocket({ client: pool as never });
            const inserted = await db.insert(items).values({ name: "ws", qty: 1 }).returning();
            expect(inserted[0]).toMatchObject({ name: "ws", qty: 1 });
            await db.update(items).set({ qty: 2 }).where(eq(items.name, "ws"));
            expect(
                await db.select({ q: items.qty }).from(items).where(eq(items.name, "ws")),
            ).toEqual([{ q: 2 }]);
        });

        it("commits and rolls back interactive transactions", async () => {
            const db = drizzleSocket({ client: pool as never });
            await db.transaction(async (tx) => {
                await tx.insert(items).values({ name: "tx-kept" });
            });
            await expect(
                db.transaction(async (tx) => {
                    await tx.insert(items).values({ name: "tx-gone" });
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");
            const names = (await db.select({ n: items.name }).from(items)).map((r) => r.n);
            expect(names).toContain("tx-kept");
            expect(names).not.toContain("tx-gone");
        });
    });
});
