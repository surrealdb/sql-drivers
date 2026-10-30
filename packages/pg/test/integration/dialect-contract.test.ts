import { Client, connect, type SqlClient } from "@surrealdb/pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

/**
 * The behaviours of the `pgsql` RPC method that a node-postgres or Neon client relies on. Runs
 * against a real server.
 */
describe.skipIf(!binary)("the pgsql dialect contract against a server", () => {
    let server: RunningServer;
    const url = () => `surrealdb+http://root:root@${server.host}/test/test`;
    const clients: SqlClient[] = [];
    const open = (extra: object = {}) => {
        const c = connect({ url: url(), ...extra });
        clients.push(c);
        return c;
    };
    const pgClient = async () => {
        const c = new Client({ url: url() });
        await c.connect();
        return c;
    };

    beforeAll(async () => {
        server = await startServer(binary as string);
        await open().surql`
            DEFINE TABLE people SCHEMAFULL;
            DEFINE FIELD name ON people TYPE string;
            DEFINE FIELD age ON people TYPE int;
            DEFINE TABLE typed SCHEMAFULL;
            DEFINE FIELD id ON typed TYPE int;
            DEFINE FIELD data ON typed TYPE object FLEXIBLE;
            DEFINE FIELD amount ON typed TYPE decimal;
            DEFINE FIELD big ON typed TYPE int;
            DEFINE FIELD at ON typed TYPE datetime;
            DEFINE FIELD flag ON typed TYPE bool;
        `;
    }, 60_000);
    afterAll(async () => {
        await Promise.all(clients.map((c) => c.close()));
        await server?.stop();
    });

    it("reads integers as numbers in text mode", async () => {
        const c = await pgClient();
        await c.query("INSERT INTO people (id, name, age) VALUES ($1, $2, $3)", [1, "A", 30]);
        const r: any = await c.query("SELECT age FROM people WHERE id = $1", [1]);
        expect(Number(r.rows[0].age)).toBe(30);
        await c.end();
    });

    it("lists RETURNING columns in the order the statement names them", async () => {
        const c = await pgClient();
        const r: any = await c.query({
            text: "INSERT INTO people (id, name, age) VALUES ($1, $2, $3) RETURNING name, id, age",
            values: [2, "B", 31],
            rowMode: "array",
        });
        expect(r.fields.map((f: { name: string }) => f.name)).toEqual(["name", "id", "age"]);
        expect(r.rows[0].map(String)).toEqual(["B", "2", "31"]);
        await c.end();
    });

    it("reads text parameters as the type of the column they are written to", async () => {
        const c = await pgClient();
        await c.query(
            "INSERT INTO typed (id, data, amount, big, at, flag) VALUES ($1,$2,$3,$4,$5,$6)",
            [
                "1",
                { a: [1, 2] },
                "12.50",
                "9007199254740993",
                new Date("2024-01-02T03:04:05Z"),
                true,
            ],
        );
        const r: any = await c.query(
            "SELECT id, data, amount, big, flag FROM typed WHERE id = $1",
            ["1"],
        );
        expect(Number(r.rows[0].id)).toBe(1);
        expect(r.rows[0].data).toEqual({ a: [1, 2] });
        expect(r.rows[0].big).toBe("9007199254740993");
        expect(Number(r.rows[0].amount)).toBe(12.5);
        await c.end();
    });

    it("reports the SQLSTATE a client branches on", async () => {
        const c = await pgClient();
        const code = async (text: string, values: unknown[] = []) =>
            (
                (await c.query(text, values).then(
                    () => undefined,
                    (e) => e,
                )) as { code?: string } | undefined
            )?.code;
        expect(await code("SELECT * FROM no_such_table")).toBe("42P01");
        expect(
            await code("INSERT INTO people (id, name, age) VALUES ($1, $2, $3)", [1, "dup", 1]),
        ).toBe("23505");
        expect(await code("INSERT INTO typed (id, amount) VALUES ($1, $2)", [9, "abc"])).toBe(
            "22P02",
        );
        await c.end();
    });

    describe("transactions opened by statement text", () => {
        it("opens a transaction for BEGIN with an isolation level or access mode", async () => {
            const sql = open({ transport: "ws" });
            for (const text of [
                "BEGIN ISOLATION LEVEL SERIALIZABLE",
                "BEGIN ISOLATION LEVEL READ COMMITTED",
                "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
                "START TRANSACTION READ ONLY",
            ]) {
                const begun = await sql.execute(text);
                expect(begun.transaction, text).toBe("active");
                const ended = await sql.execute("COMMIT");
                expect(ended.transaction, text).toBe("idle");
            }
        });

        it("refuses a write in a read-only transaction", async () => {
            const sql = open({ transport: "ws" });
            await sql.execute("BEGIN READ ONLY");
            await expect(
                sql.execute("INSERT INTO people (id, name, age) VALUES ($1, $2, $3)", [50, "X", 1]),
            ).rejects.toThrow(/read only/i);
            await sql.execute("ROLLBACK");
        });

        it("lets SET TRANSACTION choose the modes until the first statement runs", async () => {
            const sql = open({ transport: "ws" });
            await sql.execute("BEGIN");
            await sql.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
            await sql.execute("SELECT 1");
            await expect(sql.execute("SET TRANSACTION READ ONLY")).rejects.toMatchObject({
                sqlstate: "25001",
            });
            await sql.execute("ROLLBACK");
        });

        it("applies SET SESSION CHARACTERISTICS to every later transaction", async () => {
            const sql = open({ transport: "ws" });
            await sql.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
            await sql.execute("BEGIN");
            await expect(
                sql.execute("INSERT INTO people (id, name, age) VALUES ($1, $2, $3)", [51, "X", 1]),
            ).rejects.toThrow(/read only/i);
            await sql.execute("ROLLBACK");
            await sql.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE");
            await sql.execute("BEGIN");
            await sql.execute("INSERT INTO people (id, name, age) VALUES ($1, $2, $3)", [
                52,
                "Y",
                1,
            ]);
            await sql.execute("COMMIT");
        });
    });

    describe("atomic calls", () => {
        it("takes the isolation level and access mode of the transaction", async () => {
            const sql = open({ transport: "http" });
            const ok = await sql.batch(["SELECT 1"], { isolation: "serializable" });
            expect((ok[0] as { committed?: boolean }).committed).toBe(true);
            const out = await sql.batch(
                [sql`INSERT INTO people (id, name, age) VALUES (${60}, ${"Z"}, ${1})`],
                { readOnly: true, throwOnError: false },
            );
            expect((out[0] as { code?: string; message?: string }).message).toMatch(/read only/i);
        });

        it("marks the entries that ran and were rolled back", async () => {
            const sql = open({ transport: "http" });
            const out = await sql.batch(
                [
                    sql`INSERT INTO people (id, name, age) VALUES (${61}, ${"R"}, ${1})`,
                    "SELECT * FROM no_such_table",
                ],
                { throwOnError: false },
            );
            expect((out[0] as { rolledBack?: boolean }).rolledBack).toBe(true);
        });
    });
});
