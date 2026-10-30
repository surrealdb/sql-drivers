import { NeonDbError, neon, neonConfig } from "@surrealdb/pg/neon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

describe.skipIf(!binary)("neon() against a server", () => {
    let server: RunningServer;
    // the host and port of a postgres:// string are not the HTTP endpoint of the instance
    const sql = () => neon("postgres://root:root@localhost/test?ns=test");

    beforeAll(async () => {
        server = await startServer(binary as string);
        neonConfig.fetchEndpoint = `http://${server.host}/rpc`;
        const setup = await fetch(`http://${server.host}/rpc`, {
            method: "POST",
            headers: {
                authorization: `Basic ${btoa("root:root")}`,
                "surreal-ns": "test",
                "surreal-db": "test",
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({
                id: 1,
                method: "query",
                params: [
                    "DEFINE TABLE people SCHEMAFULL; DEFINE FIELD name ON people TYPE string; DEFINE FIELD age ON people TYPE int;",
                ],
            }),
        });
        expect(setup.ok).toBe(true);
    }, 60_000);
    afterAll(async () => {
        neonConfig.fetchEndpoint = undefined;
        await server?.stop();
    });

    it("inserts and selects with a tagged template", async () => {
        const db = sql();
        await db`INSERT INTO people (id, name, age) VALUES (${1}, ${"Ann"}, ${30})`;
        const rows = await db`SELECT name, age FROM people WHERE id = ${1}`;
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe("Ann");
    });

    it("runs a transaction at an isolation level and rolls it back as a whole", async () => {
        const db = sql();
        const results = await db.transaction(
            [
                db`INSERT INTO people (id, name, age) VALUES (${2}, ${"Bob"}, ${1})`,
                db`SELECT name FROM people WHERE id = ${2}`,
            ],
            { isolationLevel: "Serializable" },
        );
        expect(results).toHaveLength(2);
        await expect(
            db.transaction([
                db`INSERT INTO people (id, name, age) VALUES (${3}, ${"Cy"}, ${1})`,
                db`SELECT * FROM no_such_table`,
            ]),
        ).rejects.toBeInstanceOf(NeonDbError);
        expect(await db`SELECT name FROM people WHERE id = ${3}`).toHaveLength(0);
    });

    it("refuses a write in a read-only transaction", async () => {
        const db = sql();
        await expect(
            db.transaction([db`INSERT INTO people (id, name, age) VALUES (${4}, ${"Di"}, ${1})`], {
                readOnly: true,
            }),
        ).rejects.toThrow(/read only/i);
    });

    it("throws a NeonDbError with the SQLSTATE", async () => {
        const error: any = await sql()`SELECT * FROM no_such_table`.then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(NeonDbError);
        expect(error.code).toBe("42P01");
    });
});
