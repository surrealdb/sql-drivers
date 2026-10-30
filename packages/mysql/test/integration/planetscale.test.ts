import { connect, DatabaseError } from "@surrealdb/mysql/planetscale";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

describe.skipIf(!binary)("the PlanetScale client against a server", () => {
    let server: RunningServer;
    const open = () => connect({ url: `surrealdb+http://root:root@${server.host}/test/test` });

    beforeAll(async () => {
        server = await startServer(binary as string);
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
        await server?.stop();
    });

    it("executes with positional and named arguments", async () => {
        const conn = open();
        await conn.execute("INSERT INTO people (id, name, age) VALUES (?, ?, ?)", [1, "Ann", 30]);
        const byName = await conn.execute("SELECT name FROM people WHERE id = :id", { id: 1 });
        expect(byName.rows).toEqual([{ name: "Ann" }]);
    });

    it("throws a DatabaseError with the error number", async () => {
        const error: any = await open()
            .execute("SELECT * FROM no_such_table")
            .then(
                () => undefined,
                (e: unknown) => e,
            );
        expect(error).toBeInstanceOf(DatabaseError);
    });
});
