/**
 * The same cases run against `@planetscale/database` 2.0.0 and 1.20.2 (talking to a PlanetScale
 * HTTP stand-in) and against `@surrealdb/mysql/planetscale` (talking to the `mysql` contract
 * simulator). Version 2.0.0 removed bound arguments and `format`; version 1.20.2 still has both,
 * so the argument cases run on 1.20.2 and this package, and on 2.0.0 they assert the refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Subject, subjects } from "./subjects";

describe.each(subjects)("planetscale: $name", (subject: Subject) => {
    let client: any;
    let close: () => void;
    let config: Record<string, unknown>;

    // `execute` with options: version 2.0.0 takes them second, the others after the arguments
    const exec = (target: any, query: string, options?: object) =>
        subject.args ? target.execute(query, undefined, options) : target.execute(query, options);
    const run = (query: string, options?: object) => exec(client, query, options);
    // `execute` with arguments: only where the package takes them
    const runWith = (query: string, args: unknown, options?: object) =>
        client.execute(query, args, options);

    beforeAll(async () => {
        const started = await subject.start();
        close = () => started.engine.close();
        config = started.config;
        client = new subject.lib.Client(config as never);
        await run(
            "create table people (id integer primary key, name text not null, age integer, score real, born text, at datetime, meta json, big bigint, price decimal(10,2), ok boolean, raw blob)",
        );
        await run(
            "insert into people (id, name, age, score, born, at, meta, big, price, ok) values (1, 'Ann', 30, 1.5, '1990-05-06', '2020-01-02 03:04:05', '{\"a\":1}', 123456789012, 12.50, 1), (2, 'Bob', null, null, null, null, null, null, null, null)",
        );
    });
    afterAll(() => close());

    describe("execute", () => {
        it("returns the ExecutedQuery shape", async () => {
            const r = await run("select id, name from people order by id");
            expect(Object.keys(r).sort()).toEqual(
                [
                    "fields",
                    "headers",
                    "insertId",
                    "rows",
                    "rowsAffected",
                    "size",
                    "statement",
                    "time",
                    "types",
                ].sort(),
            );
            expect(r.headers).toEqual(["id", "name"]);
            expect(r.rows).toEqual([
                { id: 1, name: "Ann" },
                { id: 2, name: "Bob" },
            ]);
            expect(r.size).toBe(2);
            expect(r.statement).toBe("select id, name from people order by id");
            expect(r.rowsAffected).toBe(0);
            expect(r.insertId).toBe("0");
            expect(typeof r.time).toBe("number");
        });

        it("reports time in milliseconds", async () => {
            const r = await run("select id from people where id = 1");
            // the stand-in answers `timing: 0.001` seconds; the vendor reports 1 (milliseconds)
            if (subject.name !== "ours") expect(r.time).toBe(1);
            else expect(r.time).toBeGreaterThanOrEqual(0);
            expect(r.time).toBeLessThan(1000);
        });

        it("as: 'array' returns rows as arrays", async () => {
            const r = await run("select id, name from people order by id", { as: "array" });
            expect(r.rows).toEqual([
                [1, "Ann"],
                [2, "Bob"],
            ]);
        });

        it("types maps column name to Vitess type", async () => {
            const r = await run("select id, name, big, price, at from people where id = 1");
            expect(r.types.id).toBe("INT32");
            expect(r.types.name).toBe("VARCHAR");
            expect(r.types.big).toBe("INT64");
            expect(r.types.price).toBe("DECIMAL");
            expect(r.types.at).toBe("DATETIME");
        });

        it("reports rowsAffected and insertId of a write", async () => {
            const r = await run("insert into people (id, name) values (10, 'tmp')");
            expect(r.rowsAffected).toBe(1);
            expect(typeof r.insertId).toBe("string");
            expect(r.rows).toEqual([]);
            const d = await run("delete from people where id = 10");
            expect(d.rowsAffected).toBe(1);
        });

        it("a statement with no result set has empty headers and rows", async () => {
            const r = await run("update people set age = age where id = 999");
            expect(r.headers).toEqual([]);
            expect(r.rows).toEqual([]);
            expect(r.fields).toEqual([]);
            expect(r.rowsAffected).toBe(0);
        });

        it("duplicate column names collapse to the last in object mode", async () => {
            const r = await run("select id as a, age as a from people where id = 1");
            expect(r.rows).toEqual([{ a: 30 }]);
            expect(r.headers).toEqual(["a", "a"]);
        });
    });

    describe("execute(query, options)", () => {
        it.runIf(subject.name !== "vendor 1.20.2")(
            "takes as and cast second, as in version 2",
            async () => {
                const r = await client.execute("select id from people where id = 1", {
                    as: "array",
                });
                expect(r.rows).toEqual([[1]]);
                const c = await client.execute("select id from people where id = 1", {
                    cast: () => "x",
                });
                expect(c.rows).toEqual([{ id: "x" }]);
            },
        );
    });

    describe("default cast", () => {
        it("numbers for small integers and floats, strings for 64-bit, decimal and dates", async () => {
            const [row] = (
                await run("select id, age, score, big, price, at, born from people where id = 1")
            ).rows;
            expect(row.id).toBe(1);
            expect(row.age).toBe(30);
            expect(row.score).toBe(1.5);
            expect(row.big).toBe("123456789012");
            expect(row.price).toBe("12.5");
            expect(row.at).toBe("2020-01-02 03:04:05");
            expect(row.born).toBe("1990-05-06");
        });

        it("returns a binary column (charset 63) as bytes", async () => {
            await run("update people set raw = x'616263' where id = 1");
            const [row] = (await run("select raw from people where id = 1")).rows;
            expect(row.raw).toBeInstanceOf(Uint8Array);
            expect(new TextDecoder().decode(row.raw)).toBe("abc");
        });

        it("parses JSON columns", async () => {
            const [row] = (await run("select meta from people where id = 1")).rows;
            expect(row.meta).toEqual({ a: 1 });
        });

        it("null is null whatever the type", async () => {
            const [row] = (
                await run("select age, score, big, price, at, meta from people where id = 2")
            ).rows;
            expect(Object.values(row).every((v) => v === null)).toBe(true);
        });

        it("a cast on the client replaces the default", async () => {
            const c = new subject.lib.Client({
                ...config,
                cast: (field: any, value: any) =>
                    field.type === "INT32" ? `n${value}` : subject.lib.cast(field, value),
            } as never);
            const [row] = (await exec(c, "select id, name from people where id = 1")).rows;
            expect(row).toEqual({ id: "n1", name: "Ann" });
        });

        it("a cast in the call options wins over the client's", async () => {
            const c = new subject.lib.Client({
                ...config,
                cast: () => "client",
            } as never);
            const [row] = (
                await exec(c, "select id from people where id = 1", { cast: () => "call" })
            ).rows;
            expect(row).toEqual({ id: "call" });
        });

        it("the exported cast falls through to the default", async () => {
            const field = { name: "x", type: "INT64" } as any;
            expect(subject.lib.cast(field, "123456789012")).toBe("123456789012");
            expect(subject.lib.cast({ name: "x", type: "INT32" } as any, "5")).toBe(5);
            expect(subject.lib.cast({ name: "x", type: "FLOAT64" } as any, "5.5")).toBe(5.5);
            expect(subject.lib.cast({ name: "x", type: "JSON" } as any, '{"a":1}')).toEqual({
                a: 1,
            });
            expect(subject.lib.cast({ name: "x", type: "VARCHAR" } as any, "t")).toBe("t");
        });
    });

    describe("Field metadata", () => {
        it("carries name, type, table and orgName", async () => {
            const r = await run("select id, name from people");
            expect(r.fields[0]).toMatchObject({
                name: "id",
                type: "INT32",
                table: "people",
                orgName: "id",
            });
            expect(r.fields[1]).toMatchObject({ name: "name", type: "VARCHAR" });
        });

        it("reports columnLength, charset and flags as numbers", async () => {
            const r = await run("select id, name from people");
            for (const f of r.fields) {
                expect(typeof f.columnLength).toBe("number");
                expect(typeof f.charset).toBe("number");
                expect(typeof f.flags).toBe("number");
            }
            expect(r.fields[0].charset).toBe(63);
            expect(r.fields[1].charset).toBe(255);
        });
    });

    describe("bound arguments", () => {
        it.runIf(subject.args)("positional ? markers", async () => {
            const r = await runWith("select name from people where id = ? and age > ?", [1, 10]);
            expect(r.rows).toEqual([{ name: "Ann" }]);
        });

        it.runIf(subject.args)("named :name markers", async () => {
            const r = await runWith("select name from people where id = :id", { id: 2 });
            expect(r.rows).toEqual([{ name: "Bob" }]);
        });

        it.runIf(subject.args)("escapes strings, quotes, null, booleans and dates", async () => {
            const r = await runWith("select ? as s, ? as n, ? as t, ? as d", [
                "it's",
                null,
                true,
                new Date("2020-01-02T03:04:05Z"),
            ]);
            expect(r.rows[0].s).toBe("it's");
            expect(r.rows[0].n).toBeNull();
            // the vendor renders the arguments into the text; this package binds them
            if (subject.name === "ours") expect(r.statement).toContain("?");
            else expect(r.statement).toContain("'it''s'");
        });

        it.runIf(subject.args)("a placeholder inside a quoted string is not replaced", async () => {
            const r = await runWith("select '?' as q, ? as v", [5]);
            expect(r.rows[0].q).toBe("?");
            expect(Number(r.rows[0].v)).toBe(5);
        });

        it.runIf(subject.args)("format substitutes arguments into the statement text", async () => {
            const { format } = subject.lib as any;
            expect(format("select ?, ?", [1, "a"])).toBe("select 1, 'a'");
            expect(format("select :x", { x: 2 })).toBe("select 2");
        });

        it.runIf(!subject.args)(
            "version 2 refuses arguments rather than leave markers unbound",
            async () => {
                const error: any = await runWith("select ?", [1]).then(
                    () => undefined,
                    (e: Error) => e,
                );
                expect(error).toBeInstanceOf(Error);
                expect(error.message).toMatch(/not supported/i);
            },
        );

        it.runIf(subject.args)("an arguments array with the wrong count fails", async () => {
            const error: any = await runWith("select ?, ?", [1]).then(
                () => undefined,
                (e: Error) => e,
            );
            // the vendor sends the text with the second marker unfilled; this package refuses
            if (subject.name === "ours") expect(error).toBeInstanceOf(Error);
            else expect(error).toBeDefined;
        });
    });

    describe("errors", () => {
        it("throws a DatabaseError with status, body.code and body.message", async () => {
            const error: any = await run("select * from missing_table").catch((e: Error) => e);
            expect(error).toBeInstanceOf(subject.lib.DatabaseError);
            expect(error.name).toBe("DatabaseError");
            expect(error.status).toBe(400);
            expect(typeof error.body.code).toBe("string");
            expect(error.body.message).toMatch(/missing_table/);
            expect(error.message).toMatch(/missing_table/);
        });

        it("reports a duplicate key", async () => {
            const error: any = await run("insert into people (id, name) values (1, 'dup')").catch(
                (e: Error) => e,
            );
            expect(error.name).toBe("DatabaseError");
            expect(error.body.code).toBe("ALREADY_EXISTS");
        });

        it("a non-JSON reply raises an UnknownError with context", async () => {
            const broken = new subject.lib.Client({
                ...config,
                fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
            } as never);
            const error: any = await broken.execute("select 1").catch((e: Error) => e);
            expect(error).toBeInstanceOf(subject.lib.DatabaseError);
            expect(error.name).toBe("UnknownError");
            expect(error.context.status).toBe(502);
        });
    });

    describe("transaction", () => {
        it("commits what the function did", async () => {
            await client.transaction(async (tx: any) => {
                await tx.execute("insert into people (id, name) values (20, 'tx')");
                const r = await tx.execute("select name from people where id = 20");
                expect(r.rows).toEqual([{ name: "tx" }]);
            });
            expect((await run("select name from people where id = 20")).rows).toEqual([
                { name: "tx" },
            ]);
        });

        it("rolls back and rethrows when the function throws", async () => {
            const boom = new Error("boom");
            const error = await client
                .transaction(async (tx: any) => {
                    await tx.execute("insert into people (id, name) values (21, 'gone')");
                    throw boom;
                })
                .catch((e: Error) => e);
            expect(error).toBe(boom);
            expect((await run("select id from people where id = 21")).rows).toEqual([]);
        });

        it("returns the function's result", async () => {
            expect(await client.transaction(async () => 42)).toBe(42);
        });

        it("tx.execute takes as and cast", async () => {
            const rows = await client.transaction(
                async (tx: any) =>
                    (await exec(tx, "select id from people where id = 1", { as: "array" })).rows,
            );
            expect(rows).toEqual([[1]]);
        });
    });

    describe("Client and Connection", () => {
        it("connect() returns a Connection which executes", async () => {
            const conn = subject.lib.connect(config as never);
            expect(conn).toBeInstanceOf(subject.lib.Connection);
            expect((await conn.execute("select id from people where id = 1")).rows).toEqual([
                { id: 1 },
            ]);
        });

        it("Client.connection() returns a new Connection", () => {
            expect(client.connection()).toBeInstanceOf(subject.lib.Connection);
        });

        it("Connection.refresh() resolves", async () => {
            await expect(client.connection().refresh()).resolves.toBeUndefined();
        });

        it("exposes config", () => {
            expect(client.config).toBeDefined();
        });

        it("takes host, username and password in place of url", async () => {
            const { url, ...rest } = config as any;
            const c = new subject.lib.Client({
                ...rest,
                host: "localhost",
                username: "root",
                password: "root",
                ...(subject.name === "ours" ? { namespace: "t", database: "app" } : {}),
            });
            expect((await c.execute("select id from people where id = 1")).rows).toEqual([
                { id: 1 },
            ]);
        });

        it("sends credentials as HTTP Basic authorization", async () => {
            const seen: string[] = [];
            const inner = config.fetch as typeof fetch;
            const spy = ((input: any, init: any) => {
                const h = Object.fromEntries(
                    Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
                ) as Record<string, string>;
                if (h.authorization) seen.push(h.authorization);
                return inner(input, init);
            }) as typeof fetch;
            const c = new subject.lib.Client({ ...config, fetch: spy } as never);
            await c.execute("select 1");
            expect(seen[0]).toBe(`Basic ${btoa("root:root")}`);
        });
    });

    describe("exports", () => {
        it("has the documented names", () => {
            const lib = subject.lib as any;
            for (const name of ["Client", "Connection", "connect", "DatabaseError", "cast"]) {
                expect(lib[name], name).toBeDefined();
            }
            expect(typeof lib.hex).toBe("function");
        });
    });
});
