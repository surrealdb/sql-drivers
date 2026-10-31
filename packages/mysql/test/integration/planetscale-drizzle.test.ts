import { connect } from "@surrealdb/mysql";
import { Client } from "@surrealdb/mysql/planetscale";
import { eq, sql } from "drizzle-orm";
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/planetscale-serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

const items = mysqlTable("p_items", {
    id: int("id").primaryKey(),
    name: varchar("name", { length: 50 }).notNull(),
    qty: int("qty"),
});

/** Drizzle's planetscale-serverless driver, which imports `@planetscale/database`, on this entry point. */
describe.skipIf(!binary)("drizzle planetscale-serverless against a server", () => {
    let server: RunningServer;
    let client: Client;

    beforeAll(async () => {
        server = await startServer(binary as string);
        const setup = connect({ url: `surrealdb+http://root:root@${server.host}/test/test` });
        await setup.surql`DEFINE DATABASE IF NOT EXISTS pscale`;
        await setup.close();
        client = new Client({ url: `surrealdb+http://root:root@${server.host}/test/pscale` });
    }, 60_000);
    afterAll(async () => {
        await server?.stop();
    });

    it("is accepted by drizzle's instanceof check", () => {
        expect(() => drizzle(client as never)).not.toThrow();
    });

    it("inserts, selects, updates and deletes", async () => {
        const db = drizzle(client as never);
        await db.execute(
            sql`create table p_items (id int primary key, name varchar(50) not null, qty int)`,
        );
        const inserted = await db.insert(items).values([
            { id: 1, name: "a", qty: 2 },
            { id: 2, name: "b" },
        ]);
        expect(inserted.rowsAffected).toBe(2);
        expect(await db.select().from(items).orderBy(items.id)).toEqual([
            { id: 1, name: "a", qty: 2 },
            { id: 2, name: "b", qty: null },
        ]);
        const updated = await db.update(items).set({ qty: 9 }).where(eq(items.name, "b"));
        expect(updated.rowsAffected).toBe(1);
        const deleted = await db.delete(items).where(eq(items.name, "b"));
        expect(deleted.rowsAffected).toBe(1);
    });

    it("commits a transaction and rolls back a failed one", async () => {
        const db = drizzle(client as never);
        await db.transaction(async (tx) => {
            await tx.insert(items).values({ id: 10, name: "t1" });
        });
        await expect(
            db.transaction(async (tx) => {
                await tx.insert(items).values({ id: 11, name: "t2" });
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        const names = (await db.select({ n: items.name }).from(items).orderBy(items.id)).map(
            (r) => r.n,
        );
        expect(names).toContain("t1");
        expect(names).not.toContain("t2");
    });

    it("reports a failed statement as a DatabaseError", async () => {
        const db = drizzle(client as never);
        const error: any = await db.execute(sql`select * from missing_table`).catch((e) => e);
        expect((error.cause ?? error).name).toBe("DatabaseError");
    });

    it("refuses transactions when the transport is pinned to http", async () => {
        const http = new Client({
            url: `surrealdb+http://root:root@${server.host}/test/pscale`,
            transport: "http",
        });
        await expect(drizzle(http as never).transaction(async () => {})).rejects.toThrow(
            /WebSocket/,
        );
    });
});
