import { neon } from "@surrealdb/pg/neon";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { boolean, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgliteEngine } from "../../../../test-support/pglite-engine";

const URL = "postgres://root:root@localhost/app?ns=t";

let engine: PgliteEngine;
let query: ReturnType<typeof neon>;
beforeAll(async () => {
    engine = await PgliteEngine.create();
    query = neon(URL, { fetchFunction: engine.fetch });
});
afterAll(async () => {
    await engine.close();
});

describe("neon() against the pgsql contract simulator", () => {
    it("creates, inserts, selects and reports command results", async () => {
        await query`create table t (id serial primary key, name text not null, n integer, at timestamptz default now())`;
        const inserted =
            await query`insert into t (name, n) values (${"a"}, ${1}), (${"b"}, ${null}) returning id, name, n`;
        expect(inserted).toEqual([
            { id: 1, name: "a", n: 1 },
            { id: 2, name: "b", n: null },
        ]);
        const full = await query.query("select id, at from t order by id", [], {
            fullResults: true,
            arrayMode: true,
        });
        expect(full.command).toBe("SELECT");
        expect(full.rowCount).toBe(2);
        expect(full.rows[0][1]).toBeInstanceOf(Date);
        const update = await query.query("update t set n = 5 where name = $1", ["a"], {
            fullResults: true,
        });
        expect(update).toMatchObject({ command: "UPDATE", rowCount: 1, rows: [] });
    });

    it("commits a transaction atomically and rolls everything back on a failure", async () => {
        const [first, second] = await query.transaction([
            query`insert into t (name) values (${"tx1"}) returning id`,
            query`select count(*)::int as c from t`,
        ]);
        expect(first).toHaveLength(1);
        expect(second).toEqual([{ c: 3 }]);
        const error: any = await query
            .transaction([
                query`insert into t (name) values (${"tx2"})`,
                query`insert into t (name) values (${null})`,
            ])
            .catch((e) => e);
        expect(error.name).toBe("NeonDbError");
        expect(error.code).toBe("23502");
        expect(await query`select name from t where name = ${"tx2"}`).toEqual([]);
    });
});

const users = pgTable("users", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    age: integer("age"),
    active: boolean("active").default(true),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

describe("drizzle neon-http on neon()", () => {
    it("creates, inserts with returning, selects, updates and deletes", async () => {
        const db = drizzle(query as never);
        await db.execute(
            sql`create table users (id serial primary key, name text not null, age integer, active boolean default true, meta jsonb, created_at timestamptz default now())`,
        );
        const inserted = await db
            .insert(users)
            .values([{ name: "Ann", age: 30 }, { name: "Bob" }])
            .returning();
        expect(inserted).toHaveLength(2);
        expect(inserted[0]).toMatchObject({ id: 1, name: "Ann", age: 30, active: true });
        expect(typeof inserted[0].createdAt).toBe("string");
        const rows = await db
            .select({ n: users.name, a: users.age })
            .from(users)
            .where(eq(users.name, "Ann"));
        expect(rows).toEqual([{ n: "Ann", a: 30 }]);
        const updated = await db
            .update(users)
            .set({ age: 31 })
            .where(eq(users.name, "Ann"))
            .returning({ id: users.id, age: users.age });
        expect(updated).toEqual([{ id: 1, age: 31 }]);
        const res: any = await db.execute(sql`delete from users where name = 'Bob'`);
        expect(res.rowCount).toBe(1);
        expect(res.command).toBe("DELETE");
    });

    it("runs db.batch as one atomic call", async () => {
        const db = drizzle(query as never);
        const before = engine.stats.calls.length;
        const [a, b] = await db.batch([
            db.insert(users).values({ name: "B1" }).returning({ id: users.id }),
            db.select({ n: users.name }).from(users).where(eq(users.name, "B1")),
        ]);
        expect(a).toHaveLength(1);
        expect(b).toEqual([{ n: "B1" }]);
        const sent = engine.stats.calls.slice(before).filter((c) => c.method === "pgsql");
        expect(sent).toHaveLength(1);
        expect((sent[0].params[2] as { atomic?: boolean }).atomic).toBe(true);
    });

    it("keeps drizzle's behaviour of refusing interactive transactions", async () => {
        const db = drizzle(query as never);
        await expect(db.transaction(async () => {})).rejects.toThrow(/No transactions support/);
    });

    it("forwards an authToken set with $withAuth", async () => {
        const seen: (string | undefined)[] = [];
        const tokenised = neon("postgres://localhost/app?ns=t", {
            fetchFunction: ((url: string, init: RequestInit) => {
                seen.push((init.headers as Record<string, string>).Authorization);
                return engine.fetch(url, init);
            }) as never,
        });
        const db = drizzle(tokenised as never).$withAuth("jwt-1");
        await db.select({ n: users.name }).from(users).limit(1);
        expect(seen).toContain("Bearer jwt-1");
    });
});
