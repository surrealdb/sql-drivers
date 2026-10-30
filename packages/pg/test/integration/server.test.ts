import { Client, connect, Pool, type SqlClient } from "@surrealdb/pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBinary, type RunningServer, startServer } from "../../../../test-support/server";

const binary = findBinary();

/**
 * Runs against a real server. Needs a build which serves the `pgsql` RPC method (see
 * docs/DESIGN.md, "Test strategy"); a build which predates it fails the first test with a
 * "Method not found" message rather than skipping.
 */
describe.skipIf(!binary)("@surrealdb/pg against a server", () => {
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
        const setup = open();
        await setup.surql`DEFINE TABLE person SCHEMAFULL; DEFINE FIELD name ON person TYPE string; DEFINE FIELD age ON person TYPE int;`;
    }, 60_000);
    afterAll(async () => {
        await Promise.all(clients.map((c) => c.close()));
        await server?.stop();
    });

    it("the instance serves the pgsql method and the capability is on", async () => {
        const caps = await open().capabilities();
        expect(caps.reason ?? "").not.toMatch(/Method not found|predate/);
        expect(caps.supported).toBe(true);
    });

    for (const transport of ["http", "ws"] as const) {
        describe(`native over ${transport}`, () => {
            it("inserts and selects with bound parameters", async () => {
                const sql = open({ transport });
                await sql.execute("INSERT INTO person (id, name, age) VALUES ($1, $2, $3)", [
                    `p_${transport}`,
                    "Tobie",
                    40,
                ]);
                const rows = await sql`SELECT name, age FROM person WHERE name = ${"Tobie"}`;
                expect(rows.length).toBeGreaterThan(0);
                expect(rows[0]).toMatchObject({ name: "Tobie", age: 40 });
            });

            it("reports a statement error with a SQLSTATE", async () => {
                const sql = open({ transport });
                const error: any = await sql`SELECT * FROM nope_${sql.raw(transport)}`.then(
                    () => undefined,
                    (e) => e,
                );
                expect(error?.sqlstate).toMatch(/^[0-9A-Z]{5}$/);
            });

            it("describes a statement without running it", async () => {
                const d = await open({ transport }).describe(
                    "SELECT name FROM person WHERE name = $1",
                );
                expect(d.columns.map((c) => c.name)).toEqual(["name"]);
                expect(d.params).toHaveLength(1);
            });
        });
    }

    it("runs an atomic batch over HTTP and commits all or nothing", async () => {
        const sql = open({ transport: "http" });
        const results = await sql.batch([
            sql`INSERT INTO person (id, name, age) VALUES (${"b1"}, ${"A"}, ${1})`,
            sql`INSERT INTO person (id, name, age) VALUES (${"b2"}, ${"B"}, ${2})`,
        ]);
        expect(results).toHaveLength(2);
        const before = (await sql`SELECT count(*) AS n FROM person`)[0] as { n: number | string };
        await expect(
            sql.batch([
                sql`INSERT INTO person (id, name, age) VALUES (${"b3"}, ${"C"}, ${3})`,
                "SELECT * FROM nope_atomic",
            ]),
        ).rejects.toBeDefined();
        const after = (await sql`SELECT count(*) AS n FROM person`)[0] as { n: number | string };
        expect(Number(after.n)).toBe(Number(before.n));
    });

    it("runs an interactive transaction over WebSocket and rolls back on error", async () => {
        const sql = open({ transport: "ws" });
        await sql.begin(async (tx) => {
            await tx`INSERT INTO person (id, name, age) VALUES (${"t1"}, ${"T"}, ${1})`;
        });
        await expect(
            sql.begin(async (tx) => {
                await tx`INSERT INTO person (id, name, age) VALUES (${"t2"}, ${"T"}, ${2})`;
                throw new Error("abort");
            }),
        ).rejects.toThrow("abort");
        const ids = (await sql`SELECT id FROM person WHERE name = ${"T"}`).map((r) => String(r.id));
        expect(ids).toHaveLength(1);
    });

    it("opens a serializable transaction through the begin method, then commits and rolls back", async () => {
        const sql = open({ transport: "ws" });
        await sql.begin(
            async (tx) => {
                await tx`INSERT INTO person (id, name, age) VALUES (${"i1"}, ${"Iso"}, ${1})`;
            },
            { isolation: "serializable" },
        );
        await expect(
            sql.begin(
                async (tx) => {
                    await tx`INSERT INTO person (id, name, age) VALUES (${"i2"}, ${"Iso"}, ${2})`;
                    throw new Error("abort");
                },
                { isolation: "repeatable read", readOnly: false },
            ),
        ).rejects.toThrow("abort");
        const rows = await sql`SELECT id FROM person WHERE name = ${"Iso"}`;
        expect(rows).toHaveLength(1);
    });

    it("reports an uncommitted atomic call, whatever the status of its earlier entries", async () => {
        const sql = open({ transport: "http" });
        const out = await sql.batch(
            [
                sql`INSERT INTO person (id, name, age) VALUES (${"a1"}, ${"Atomic"}, ${1})`,
                "SELECT * FROM nope_atomic2",
            ],
            { throwOnError: false },
        );
        expect((out[0] as { committed?: boolean }).committed).toBe(false);
        expect(await sql`SELECT id FROM person WHERE name = ${"Atomic"}`).toHaveLength(0);
    });

    it("applies session settings with every HTTP call, and refuses them with an atomic call", async () => {
        const sql = open({ transport: "http", settings: { timezone: "UTC" } });
        const rows = await sql.query("SHOW timezone");
        expect(rows.rows[0]).toEqual({ timezone: "UTC" });
        await expect(sql.batch(["SELECT 1"])).rejects.toThrow(/atomic/);
    });

    it("decodes native values by wire type", async () => {
        const sql = open({ transport: "http" });
        const r = await sql.query("SELECT 1 AS n, 'x' AS t, true AS b, now() AS d");
        expect(r.rows[0]).toMatchObject({ n: 1, t: "x", b: true });
        expect(r.rows[0].d).toBeInstanceOf(Date);
    });

    it("refuses an interactive transaction when pinned to HTTP", async () => {
        await expect(open({ transport: "http" }).begin(async () => 1)).rejects.toThrow(/WebSocket/);
    });

    it("answers SurrealQL on the same connection", async () => {
        const out = await open().surql`RETURN ${1} + ${2}`;
        expect(out).toEqual([3]);
    });

    it("the node-postgres layer works over a WebSocket session", async () => {
        const client = new Client({ url: url() });
        await client.connect();
        const r: any = await client.query("SELECT name FROM person WHERE name = $1", ["Tobie"]);
        expect(r.rows[0].name).toBe("Tobie");
        expect(r.fields[0].dataTypeID).toBeLessThan(16384);
        await client.end();
    });

    it("the pool serves one-shot queries", async () => {
        const pool = new Pool({ url: url() });
        const r: any = await pool.query("SELECT 1 AS one");
        expect(Number(r.rows[0].one)).toBe(1);
        await pool.end();
    });
});
