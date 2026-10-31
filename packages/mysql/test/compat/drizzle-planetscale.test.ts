import { Client } from "@surrealdb/mysql/planetscale";
import { FakeSocket, routing } from "@surrealdb/sql-internal/testing";
import { eq, sql } from "drizzle-orm";
import { int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/planetscale-serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteMysqlEngine } from "../../../../test-support/sqlite-mysql-engine";

const items = mysqlTable("items", {
    id: int("id").primaryKey(),
    name: varchar("name", { length: 50 }).notNull(),
    note: text("note"),
});

let engine: SqliteMysqlEngine;
let client: Client;
beforeAll(() => {
    engine = new SqliteMysqlEngine();
    FakeSocket.reset(routing((m, p) => engine.handle("ws", m, p)));
    client = new Client({
        url: "mysql://root:root@localhost/app?ns=t",
        WebSocket: FakeSocket as never,
        fetch: engine.fetch,
    });
});
afterAll(() => {
    engine.close();
});

describe("drizzle planetscale-serverless on the Client of @surrealdb/mysql/planetscale", () => {
    it("is accepted by drizzle's instanceof check", () => {
        expect(() => drizzle(client as never)).not.toThrow();
    });

    it("inserts, selects, updates and deletes", async () => {
        const db = drizzle(client as never);
        await db.execute(
            sql`create table items (id integer primary key, name text not null, note text)`,
        );
        const inserted = await db.insert(items).values([
            { id: 1, name: "a", note: null },
            { id: 2, name: "b", note: "n" },
        ]);
        expect(inserted.rowsAffected).toBe(2);
        expect(typeof inserted.insertId).toBe("string");
        const rows = await db.select().from(items).orderBy(items.id);
        expect(rows).toEqual([
            { id: 1, name: "a", note: null },
            { id: 2, name: "b", note: "n" },
        ]);
        const updated = await db.update(items).set({ note: "x" }).where(eq(items.name, "a"));
        expect(updated.rowsAffected).toBe(1);
        const deleted = await db.delete(items).where(eq(items.name, "b"));
        expect(deleted.rowsAffected).toBe(1);
        expect(await db.select({ n: items.name, t: items.note }).from(items)).toEqual([
            { n: "a", t: "x" },
        ]);
    });

    it("commits a transaction, rolls back a failed one, and supports savepoints", async () => {
        const db = drizzle(client as never);
        await db.transaction(async (tx) => {
            await tx.insert(items).values({ id: 10, name: "t1", note: null });
            await tx
                .transaction(async (inner) => {
                    await inner.insert(items).values({ id: 11, name: "t2", note: null });
                    throw new Error("inner");
                })
                .catch(() => {});
        });
        await expect(
            db.transaction(async (tx) => {
                await tx.insert(items).values({ id: 12, name: "t3", note: null });
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        const names = (await db.select({ n: items.name }).from(items).orderBy(items.id)).map(
            (r) => r.n,
        );
        expect(names).toEqual(["a", "t1"]);
    });

    it("reports a failed statement as a DatabaseError", async () => {
        const db = drizzle(client as never);
        const error: any = await db.execute(sql`select * from missing`).catch((e) => e);
        expect(error.cause.name).toBe("DatabaseError");
        expect(error.cause.body.message).toMatch(/no such table/);
    });

    it("refuses transactions when the transport is pinned to http", async () => {
        const http = new Client({
            url: "mysql://root:root@localhost/app?ns=t",
            transport: "http",
            fetch: engine.fetch,
        });
        await expect(drizzle(http as never).transaction(async () => {})).rejects.toThrow(
            /WebSocket/,
        );
    });

    it("builds its own client from a connection config", async () => {
        const db = drizzle({
            connection: { url: "mysql://root:root@localhost/app?ns=t", fetch: engine.fetch },
        });
        expect(await db.select({ n: items.name }).from(items).where(eq(items.id, 1))).toEqual([
            { n: "a" },
        ]);
    });
});
