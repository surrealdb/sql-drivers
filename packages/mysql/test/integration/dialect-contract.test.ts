import { connect, type SqlClient } from "@surrealdb/mysql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

/** The behaviours of the `mysql` RPC method that a mysql2 or PlanetScale client relies on. */
describe.skipIf(!binary)("the mysql dialect contract against a server", () => {
    let server: RunningServer;
    const url = () => `surrealdb+http://root:root@${server.host}/test/test`;
    const clients: SqlClient[] = [];
    const open = (extra: object = {}) => {
        const c = connect({ url: url(), ...extra });
        clients.push(c);
        return c;
    };

    beforeAll(async () => {
        server = await startServer(binary as string);
        await open().surql`
            DEFINE TABLE people SCHEMAFULL;
            DEFINE FIELD name ON people TYPE string;
            DEFINE FIELD age ON people TYPE int;
        `;
    }, 60_000);
    afterAll(async () => {
        await Promise.all(clients.map((c) => c.close()));
        await server?.stop();
    });

    it("opens a read-only transaction for START TRANSACTION READ ONLY", async () => {
        const sql = open({ transport: "ws" });
        const begun = await sql.execute("START TRANSACTION READ ONLY");
        expect(begun.transaction).toBe("active");
        await expect(
            sql.execute("INSERT INTO people (id, name, age) VALUES (?, ?, ?)", [1, "A", 1]),
        ).rejects.toThrow(/read only/i);
        await sql.execute("ROLLBACK");
    });

    it("opens a transaction for START TRANSACTION WITH CONSISTENT SNAPSHOT", async () => {
        const sql = open({ transport: "ws" });
        expect((await sql.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT")).transaction).toBe(
            "active",
        );
        await sql.execute("COMMIT");
    });

    it("applies SET SESSION TRANSACTION READ ONLY to later transactions", async () => {
        const sql = open({ transport: "ws" });
        await sql.execute("SET SESSION TRANSACTION READ ONLY");
        await sql.execute("START TRANSACTION");
        await expect(
            sql.execute("INSERT INTO people (id, name, age) VALUES (?, ?, ?)", [2, "B", 1]),
        ).rejects.toThrow(/read only/i);
        await sql.execute("ROLLBACK");
    });

    it("reports the error number a client branches on", async () => {
        const error: any = await open()
            .query("SELECT * FROM no_such_table")
            .then(
                () => undefined,
                (e) => e,
            );
        expect(error?.errno).toBe(1146);
        expect(error?.sqlstate).toBe("42S02");
    });

    it("marks the entries of an uncommitted atomic call as rolled back", async () => {
        const sql = open({ transport: "http" });
        const out = await sql.batch(
            [
                sql`INSERT INTO people (id, name, age) VALUES (${3}, ${"C"}, ${1})`,
                "SELECT * FROM nope",
            ],
            { throwOnError: false },
        );
        expect((out[0] as { rolledBack?: boolean }).rolledBack).toBe(true);
    });
});
