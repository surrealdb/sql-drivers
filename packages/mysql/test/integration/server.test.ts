import { connect, createPool, type SqlClient } from "@surrealdb/mysql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

/** Runs against a real server which serves the `mysql` RPC method; see docs/DESIGN.md. */
describe.skipIf(!binary)("@surrealdb/mysql against a server", () => {
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
        await open()
            .surql`DEFINE TABLE person SCHEMAFULL; DEFINE FIELD name ON person TYPE string; DEFINE FIELD age ON person TYPE int;`;
    }, 60_000);
    afterAll(async () => {
        await Promise.all(clients.map((c) => c.close()));
        await server?.stop();
    });

    it("the instance serves the mysql method and the capability is on", async () => {
        const caps = await open().capabilities();
        expect(caps.reason ?? "").not.toMatch(/Method not found|predate/);
        expect(caps.supported).toBe(true);
    });

    for (const transport of ["http", "ws"] as const) {
        it(`inserts and selects with bound parameters over ${transport}`, async () => {
            const sql = open({ transport });
            await sql.execute("INSERT INTO person (id, name, age) VALUES (?, ?, ?)", [
                `m_${transport}`,
                "Tobie",
                40,
            ]);
            const rows = await sql`SELECT name, age FROM person WHERE name = ${"Tobie"}`;
            expect(rows[0]).toMatchObject({ name: "Tobie", age: 40 });
        });
    }

    it("reports an error number and SQLSTATE", async () => {
        const error: any = await open()
            .query("SELECT * FROM nope_mysql")
            .then(
                () => undefined,
                (e) => e,
            );
        expect(typeof error?.errno).toBe("number");
        expect(error?.sqlstate).toMatch(/^[0-9A-Z]{5}$/);
    });

    it("the mysql2-style pool returns [rows, fields]", async () => {
        const pool = createPool({ uri: url() });
        const [rows, fields] = (await pool.query("SELECT name FROM person WHERE name = ?", [
            "Tobie",
        ])) as [any[], any[]];
        expect(rows[0].name).toBe("Tobie");
        expect(fields[0].name).toBe("name");
        await pool.end();
    });
});
