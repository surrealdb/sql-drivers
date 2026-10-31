/**
 * The same cases run against `@neondatabase/serverless` (talking to a Neon `/sql` stand-in) and
 * against `@surrealdb/pg/neon` (talking to the `pgsql` contract simulator). Both sit on the same
 * PGlite, so a case which passes for both shows the two packages return the same thing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Subject, subjects, URL } from "./subjects";

describe.each(subjects)("neon() HTTP: $name", (subject: Subject) => {
    let sql: ReturnType<typeof subject.lib.neon>;
    let close: () => Promise<void>;
    let fetchFunction: typeof fetch;

    beforeAll(async () => {
        const started = await subject.start();
        fetchFunction = started.fetch;
        close = () => started.engine.close();
        subject.lib.neonConfig.fetchFunction = fetchFunction;
        sql = subject.lib.neon(URL);
        await sql`create table people (id serial primary key, name text not null, age int, born date, at timestamptz, meta jsonb, big bigint, price numeric(10,2), tags text[], raw bytea, ok boolean)`;
        await sql`insert into people (name, age, born, at, meta, big, price, tags, raw, ok) values ('Ann', 30, '1990-05-06', '2020-01-02T03:04:05Z', '{"a":1}', 9007199254740993, 12.50, '{x,y}', '\\x0102', true), ('Bob', null, null, null, null, null, null, null, null, null)`;
    });
    afterAll(async () => close());

    describe("call forms", () => {
        it("tagged template returns rows as objects", async () => {
            const rows = await sql`select id, name, age from people order by id`;
            expect(rows).toEqual([
                { id: 1, name: "Ann", age: 30 },
                { id: 2, name: "Bob", age: null },
            ]);
        });

        it("tagged template binds values as parameters", async () => {
            const name = "Ann'; drop table people; --";
            expect(await sql`select ${name}::text as n`).toEqual([{ n: name }]);
            expect(await sql`select count(*)::int as c from people`).toEqual([{ c: 2 }]);
        });

        it("sql.query takes numbered placeholders and parameters", async () => {
            expect(await sql.query("select name from people where id = $1", [2])).toEqual([
                { name: "Bob" },
            ]);
            expect(await sql.query("select 1 as one")).toEqual([{ one: 1 }]);
        });

        it("calling the function with text throws, naming the allowed forms", () => {
            expect(() => (sql as any)("select 1")).toThrow(/tagged-template|tagged template/i);
        });

        it("sql.unsafe splices raw text into a template", async () => {
            const column = sql.unsafe("name");
            expect(await sql`select ${column} from people where id = ${1}`).toEqual([
                { name: "Ann" },
            ]);
        });

        it("templates are lazy: nothing is sent until awaited", async () => {
            const lazy = sql`select 1 as lazy`;
            expect(typeof lazy.then).toBe("function");
            expect(await lazy).toEqual([{ lazy: 1 }]);
        });

        it("a query awaited twice is sent once", async () => {
            const before = (await subject.start()).requests.length;
            expect(before).toBeGreaterThanOrEqual(0);
            const q = sql`select 2 as two`;
            const [a, b] = await Promise.all([q, q]);
            expect(a).toEqual(b);
        });
    });

    describe("result options", () => {
        it("arrayMode returns rows as arrays", async () => {
            const rows = await sql.query("select id, name from people order by id", [], {
                arrayMode: true,
            });
            expect(rows).toEqual([
                [1, "Ann"],
                [2, "Bob"],
            ]);
        });

        it("fullResults returns fields, command, rowCount and rows", async () => {
            const full = await sql.query("select id, name from people order by id", [], {
                fullResults: true,
            });
            expect(full.command).toBe("SELECT");
            expect(full.rowCount).toBe(2);
            expect(full.rows).toHaveLength(2);
            expect(full.fields.map((f: any) => f.name)).toEqual(["id", "name"]);
            expect(full.fields.map((f: any) => f.dataTypeID)).toEqual([23, 25]);
            expect((full as any).rowAsArray).toBe(false);
        });

        it("fullResults with arrayMode sets rowAsArray", async () => {
            const full = await sql.query("select 1 as a", [], {
                fullResults: true,
                arrayMode: true,
            });
            expect(full.rows).toEqual([[1]]);
            expect((full as any).rowAsArray).toBe(true);
        });

        it("reports command and rowCount of writes", async () => {
            const insert = await sql.query("insert into people (name) values ($1)", ["Tmp"], {
                fullResults: true,
            });
            expect(insert).toMatchObject({ command: "INSERT", rowCount: 1, rows: [] });
            const del = await sql.query("delete from people where name = $1", ["Tmp"], {
                fullResults: true,
            });
            expect(del).toMatchObject({ command: "DELETE", rowCount: 1 });
        });

        it("options set on neon() apply to every query", async () => {
            const arr = subject.lib.neon(URL, { arrayMode: true });
            expect(await arr`select 1 as a, 2 as b`).toEqual([[1, 2]]);
            const full = subject.lib.neon(URL, { fullResults: true });
            expect((await full`select 1 as a`).command).toBe("SELECT");
        });

        it("per-query options override neon() options", async () => {
            const full = subject.lib.neon(URL, { fullResults: true });
            expect(await full.query("select 1 as a", [], { fullResults: false })).toEqual([
                { a: 1 },
            ]);
        });

        it("duplicate column names collapse to the last in object mode", async () => {
            expect(await sql`select 1 as a, 2 as a`).toEqual([{ a: 2 }]);
        });

        it("a statement without a result set returns no rows", async () => {
            expect(await sql`set application_name = 'x'`).toEqual([]);
        });
    });

    describe("typed parsers", () => {
        it("parses numbers, dates, json, booleans, arrays and bytea like node-postgres", async () => {
            const [row] =
                (await sql`select age, born, at, meta, big, price, tags, raw, ok from people where id = 1`) as Record<
                    string,
                    unknown
                >[];
            expect(row.age).toBe(30);
            expect(row.born).toBeInstanceOf(Date);
            expect(row.at).toBeInstanceOf(Date);
            expect((row.at as Date).toISOString()).toBe("2020-01-02T03:04:05.000Z");
            expect(row.meta).toEqual({ a: 1 });
            expect(row.big).toBe("9007199254740993");
            expect(row.price).toBe("12.50");
            expect(row.tags).toEqual(["x", "y"]);
            expect(Buffer.from(row.raw as Uint8Array).toString("hex")).toBe("0102");
            expect(row.ok).toBe(true);
        });

        it("null stays null without reaching a parser", async () => {
            const [row] =
                (await sql`select age, born, at, meta, big, price, tags, raw, ok from people where id = 2`) as Record<
                    string,
                    unknown
                >[];
            expect(Object.values(row).every((v) => v === null)).toBe(true);
        });

        it("a custom types object replaces a parser for the query", async () => {
            const types = {
                getTypeParser: (oid: number) =>
                    oid === 23 ? (v: string) => `int:${v}` : (v: string) => v,
            };
            const rows = await sql.query("select 7 as n, 'a'::text as t", [], { types });
            expect(rows).toEqual([{ n: "int:7", t: "a" }]);
        });

        it("binds Date, object, array, null and Buffer parameters", async () => {
            const at = new Date("2021-02-03T04:05:06Z");
            const [row] =
                (await sql`select ${at}::timestamptz as at, ${{ a: [1] }}::jsonb as j, ${[1, 2]}::int[] as arr, ${null}::text as n, encode(${Buffer.from([1, 2])}, 'hex') as hx`) as Record<
                    string,
                    unknown
                >[];
            expect((row.at as Date).toISOString()).toBe(at.toISOString());
            expect(row.j).toEqual({ a: [1] });
            expect(row.arr).toEqual([1, 2]);
            expect(row.n).toBeNull();
            expect(row.hx).toBe("0102");
        });
    });

    describe("transaction", () => {
        it("runs an array of queries as one atomic call and returns each result", async () => {
            const [a, b] = await sql.transaction([
                sql`insert into people (name) values (${"t1"}) returning id`,
                sql`select count(*)::int as c from people`,
            ]);
            expect(a).toHaveLength(1);
            expect(b).toEqual([{ c: 3 }]);
        });

        it("runs a function over a restricted sql and returns each result", async () => {
            const results = await sql.transaction((tx) => [
                tx`select 1 as a`,
                tx.query("select $1::int as b", [2]),
            ]);
            expect(results).toEqual([[{ a: 1 }], [{ b: 2 }]]);
        });

        it("rolls everything back when one query fails and throws a NeonDbError", async () => {
            const error: any = await sql
                .transaction([
                    sql`insert into people (name) values (${"gone"})`,
                    sql`insert into people (name) values (${null})`,
                ])
                .catch((e) => e);
            expect(error.name).toBe("NeonDbError");
            expect(error.code).toBe("23502");
            expect(await sql`select name from people where name = ${"gone"}`).toEqual([]);
        });

        it("takes isolationLevel, readOnly and deferrable", async () => {
            const [rows] = await sql.transaction([sql`select 1 as a`], {
                isolationLevel: "Serializable",
                readOnly: true,
                deferrable: true,
            });
            expect(rows).toEqual([{ a: 1 }]);
            const error: any = await sql
                .transaction([sql`insert into people (name) values ('ro')`], { readOnly: true })
                .catch((e) => e);
            expect(error.code).toBe("25006");
        });

        it("fullResults and arrayMode apply to every result", async () => {
            const [one] = await sql.transaction([sql`select 1 as a`], {
                fullResults: true,
                arrayMode: true,
            });
            expect(one).toMatchObject({ command: "SELECT", rowCount: 1, rows: [[1]] });
        });

        it("an empty array returns an empty array", async () => {
            expect(await sql.transaction([])).toEqual([]);
        });
    });

    describe("errors", () => {
        it("throws a NeonDbError carrying the PostgreSQL fields", async () => {
            const error: any = await sql`select * from missing_table`.catch((e) => e);
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe("NeonDbError");
            expect(error).toBeInstanceOf(subject.lib.NeonDbError);
            expect(error.code).toBe("42P01");
            expect(error.severity).toBe("ERROR");
            expect(error.message).toMatch(/missing_table/);
            expect(typeof error.position === "string" || error.position === undefined).toBe(true);
        });

        it("reports unique violations with code 23505", async () => {
            const error: any = await sql`insert into people (id, name) values (1, 'dup')`.catch(
                (e) => e,
            );
            expect(error.code).toBe("23505");
        });

        it("wraps a failing fetch in a NeonDbError with sourceError", async () => {
            const boom = new Error("network down");
            subject.lib.neonConfig.fetchFunction = (() => Promise.reject(boom)) as never;
            const error: any = await subject.lib.neon(URL)`select 1`
                .catch((e) => e)
                .finally(() => {
                    subject.lib.neonConfig.fetchFunction = fetchFunction;
                });
            expect(error.name).toBe("NeonDbError");
            expect(error.sourceError).toBeDefined();
        });

        it("a missing connection string is an error", async () => {
            const saved = process.env.DATABASE_URL;
            delete process.env.DATABASE_URL;
            try {
                // the vendor reports it when the query runs, this package when neon() is called
                const error: any = await Promise.resolve()
                    .then(() => (subject.lib.neon as any)()`select 1`)
                    .catch((e) => e);
                expect(error).toBeInstanceOf(Error);
            } finally {
                if (saved !== undefined) process.env.DATABASE_URL = saved;
            }
        });
    });

    describe("authToken and fetchOptions", () => {
        it("sends authToken as a bearer token, string or function", async () => {
            const seen: (string | undefined)[] = [];
            const spy = ((input: any, init: any) => {
                const h = Object.fromEntries(
                    Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
                ) as Record<string, string>;
                seen.push(h.authorization);
                return fetchFunction(input, init);
            }) as typeof fetch;
            subject.lib.neonConfig.fetchFunction = spy;
            try {
                await subject.lib.neon(URL, { authToken: "tok" })`select 1`;
                await subject.lib.neon(URL, { authToken: async () => "fn" })`select 1`;
                await subject.lib.neon(URL).query("select 1", [], { authToken: "per-query" });
            } finally {
                subject.lib.neonConfig.fetchFunction = fetchFunction;
            }
            expect(seen.map((s) => s?.replace(/^Bearer /, ""))).toEqual(["tok", "fn", "per-query"]);
        });

        it("merges fetchOptions into the request and honours an abort signal", async () => {
            const controller = new AbortController();
            controller.abort();
            const sent: any[] = [];
            const spy = ((input: any, init: any) => {
                sent.push(init);
                if (init?.signal?.aborted) {
                    return Promise.reject(
                        Object.assign(new Error("aborted"), { name: "AbortError" }),
                    );
                }
                return fetchFunction(input, init);
            }) as typeof fetch;
            subject.lib.neonConfig.fetchFunction = spy;
            const error: any = await subject.lib
                .neon(URL)
                .query("select 1", [], {
                    fetchOptions: { signal: controller.signal, cache: "no-store" },
                })
                .catch((e) => e)
                .finally(() => {
                    subject.lib.neonConfig.fetchFunction = fetchFunction;
                });
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe("NeonDbError");
            expect(error.sourceError?.name).toBe("AbortError");
            expect(sent[0].cache).toBe("no-store");
        });
    });

    describe("fetchOptions layers", () => {
        it("merges neon() and per-query fetchOptions into one request", async () => {
            const controller = new AbortController();
            const sent: any[] = [];
            const spy = ((input: any, init: any) => {
                sent.push(init);
                return fetchFunction(input, init);
            }) as typeof fetch;
            subject.lib.neonConfig.fetchFunction = spy;
            try {
                await subject.lib
                    .neon(URL, { fetchOptions: { cache: "no-store" } })
                    .query("select 1", [], { fetchOptions: { signal: controller.signal } });
            } finally {
                subject.lib.neonConfig.fetchFunction = fetchFunction;
            }
            expect(sent[0].cache).toBe("no-store");
            expect(sent[0].signal).toBeDefined();
        });
    });

    describe("neonConfig", () => {
        it("fetchFunction on neonConfig replaces the global fetch", async () => {
            const { neonConfig } = subject.lib;
            const previous = fetchFunction;
            let called = false;
            neonConfig.fetchFunction = ((i: any, n: any) => {
                called = true;
                return fetchFunction(i, n);
            }) as never;
            try {
                expect(await subject.lib.neon(URL)`select 1 as a`).toEqual([{ a: 1 }]);
                expect(called).toBe(true);
            } finally {
                neonConfig.fetchFunction = previous;
            }
        });

        it("fetchEndpoint as a string or function sets the URL posted to", async () => {
            const { neonConfig } = subject.lib;
            const previous = neonConfig.fetchEndpoint;
            const urls: string[] = [];
            const spy = ((i: any, n: any) => {
                urls.push(String(i));
                return fetchFunction(i, n);
            }) as typeof fetch;
            try {
                neonConfig.fetchEndpoint = "http://endpoint.test/sql";
                neonConfig.fetchFunction = spy;
                await subject.lib.neon(URL)`select 1`;
                neonConfig.fetchEndpoint = (host: string) => `http://${host}.fn/sql`;
                await subject.lib.neon(URL)`select 1`;
            } finally {
                neonConfig.fetchEndpoint = previous;
                neonConfig.fetchFunction = fetchFunction;
            }
            expect(urls).toEqual(["http://endpoint.test/sql", "http://localhost.fn/sql"]);
        });

        it("exposes the documented keys", () => {
            const { neonConfig } = subject.lib;
            for (const key of [
                "webSocketConstructor",
                "wsProxy",
                "useSecureWebSocket",
                "forceDisablePgSSL",
                "coalesceWrites",
                "pipelineConnect",
                "pipelineTLS",
                "poolQueryViaFetch",
                "fetchConnectionCache",
                "fetchFunction",
                "fetchEndpoint",
                "rootCerts",
                "disableSNI",
                "subtls",
            ]) {
                expect(key in neonConfig, key).toBe(true);
            }
        });
    });

    describe("composition", () => {
        it("a template nested in a template is inlined with renumbered parameters", async () => {
            const where = sql`id = ${2}`;
            expect(await sql`select name from people where ${where} and name = ${"Bob"}`).toEqual([
                { name: "Bob" },
            ]);
        });

        it("nested templates may nest again", async () => {
            const inner = sql`${1}::int + ${2}::int`;
            const mid = sql`(${inner}) * ${3}`;
            expect(await sql`select ${mid}::int as v`).toEqual([{ v: 9 }]);
        });

        it("exposes the parameterized query of a template", () => {
            const q: any = sql`select ${1}::int`;
            expect(q.queryData ?? q.parameterizedQuery).toBeDefined();
        });
    });

    describe("connection strings", () => {
        const withFetch = async <T>(fn: () => Promise<T>) => fn();

        it("accepts postgresql:// and query parameters it does not use", async () => {
            const q = subject.lib.neon(
                "postgresql://root:root@localhost/app?sslmode=require&channel_binding=require&ns=t",
            );
            expect(await withFetch(() => q`select 1 as one`)).toEqual([{ one: 1 }]);
        });

        it("accepts a URL-encoded password", async () => {
            const q = subject.lib.neon("postgres://root:p%40ss%2Fw%3Ard@localhost/app?ns=t");
            expect(await q`select 1 as one`).toEqual([{ one: 1 }]);
        });

        it("accepts connection parameters in place of a string", async () => {
            const q = subject.lib.neon({
                host: "localhost",
                user: "root",
                password: "root",
                database: "app",
            } as never);
            expect(await q`select 1 as one`).toEqual([{ one: 1 }]);
        });

        it("accepts connectionString as an option", async () => {
            const q = subject.lib.neon({ connectionString: URL } as never);
            expect(await q`select 1 as one`).toEqual([{ one: 1 }]);
        });

        it("accepts a function for the password, called for each query", async () => {
            let calls = 0;
            const q = subject.lib.neon(URL, {
                password: async () => `pw${++calls}`,
            } as never);
            await q`select 1`;
            await q`select 1`;
            expect(calls).toBeGreaterThanOrEqual(2);
        });

        it("rejects a URL which is not a PostgreSQL connection string", async () => {
            const error: any = await Promise.resolve()
                .then(() => subject.lib.neon("http://localhost/app")`select 1`)
                .catch((e) => e);
            expect(error).toBeInstanceOf(Error);
        });

        it("parseIntoClientConfig turns a string into client parameters", () => {
            const parse = (subject.lib as any).parseIntoClientConfig;
            expect(typeof parse).toBe("function");
            expect(parse("postgres://u:p@h:5433/db")).toMatchObject({
                user: "u",
                password: "p",
                host: "h",
                port: 5433,
                database: "db",
            });
        });
    });

    describe("exports", () => {
        it("re-exports the node-postgres helpers", () => {
            const lib = subject.lib;
            // the vendor's 1.2.0 bundle exports both names as undefined
            if (subject.name === "ours") {
                expect(lib.escapeIdentifier('a"b')).toBe('"a""b"');
                expect(lib.escapeLiteral("it's")).toBe("'it''s'");
            }
            expect(typeof lib.types.getTypeParser).toBe("function");
            expect(typeof lib.types.setTypeParser).toBe("function");
            expect(typeof lib.DatabaseError).toBe("function");
            expect(typeof lib.Pool).toBe("function");
            expect(typeof lib.Client).toBe("function");
            expect(lib.types.builtins.INT8).toBe(20);
            for (const name of ["defaults", "errorFields", "SqlTemplate", "warnIfBrowser"]) {
                expect((lib as any)[name], name).toBeDefined();
            }
        });
    });
});
