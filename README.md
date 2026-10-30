# sql-drivers

SurrealDB clients for the PostgreSQL and MySQL dialects, for serverless, edge and browser runtimes where TCP is unavailable.

| Package                              | Dialect    | RPC method | Docs                               |
| ------------------------------------ | ---------- | ---------- | ---------------------------------- |
| [`@surrealdb/pg`](packages/pg)       | PostgreSQL | `pgsql`    | [README](packages/pg/README.md)    |
| [`@surrealdb/mysql`](packages/mysql) | MySQL      | `mysql`    | [README](packages/mysql/README.md) |

Both packages send SQL text to a SurrealDB instance over its RPC `pgsql` or `mysql` method, on HTTP for one-shot work and on a WebSocket for sessions. Each has a native API (a tagged template plus `query`, `batch` and `begin`) and a compatibility layer that lets existing ORMs and query builders run on top of it.

- [When to use these packages](#when-to-use-these-packages)
- [Status](#status)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Connecting](#connecting)
- [Native API](#native-api)
- [Transactions and transports](#transactions-and-transports)
- [Results and value types](#results-and-value-types)
- [Errors](#errors)
- [SurrealDB extras](#surrealdb-extras)
- [ORM and driver compatibility](#orm-and-driver-compatibility)
- [Runtimes and bundle size](#runtimes-and-bundle-size)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Design documents](#design-documents)

## When to use these packages

Use them when your code runs where a TCP socket is not available and you want to speak PostgreSQL or MySQL to SurrealDB: Cloudflare Workers, Vercel Edge, Deno Deploy, browsers, and any Node, Bun or Deno process that prefers HTTP and WebSocket.

If your code can open TCP connections, a native driver (`pg`, `mysql2`, and others) can connect to the PostgreSQL and MySQL wire listeners of an instance directly. These packages are the alternative for the places those drivers cannot run.

If you want SurrealQL and the full SurrealDB data model from JavaScript, use the [`surrealdb`](https://github.com/surrealdb/surrealdb.js) SDK. These packages are for SQL in the PostgreSQL and MySQL dialects, with SurrealQL available on the same connection through `surql`.

## Status

The `pgsql` and `mysql` RPC methods are merged in the engine, and the integration suites for both packages run against a build of it (`b2b70df36f`, the merge of the methods): native queries over HTTP and WebSocket, atomic batches, interactive transactions with and without an isolation level, session settings and live query registration, and the Drizzle, Kysely and `pg.Pool` adapters, plus Drizzle and Kysely for MySQL.

Some behaviours of that build differ from the contract or from PostgreSQL, and they limit what works today: `RETURNING` lists its columns in name order (which breaks Drizzle's and Prisma's `RETURNING`), text-mode integers carry a sized-number suffix, string parameters are not coerced to `jsonb`, `numeric` or large `int8` fields, and a transaction start with an isolation level is silently ignored in text. [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) lists each one, and which adapter suites pass against the simulators and against the server.

Prisma's `adapter-pg` is verified only against the simulator, because the `RETURNING` order blocks it on the server. The MySQL native value encoding is provisional until the instance documents it.

## Quick start

PostgreSQL:

```bash
npm install @surrealdb/pg
```

```ts
import { connect } from "@surrealdb/pg";

const sql = connect("postgres://root:root@abc123.surrealdb.earth/app?namespace=prod");

const name = "Tobie";
const rows = await sql`SELECT name, age FROM person WHERE name = ${name}`;
```

MySQL:

```bash
npm install @surrealdb/mysql
```

```ts
import { connect } from "@surrealdb/mysql";

const sql = connect("mysql://root:root@abc123.surrealdb.earth/app?namespace=prod");

const name = "Tobie";
const rows = await sql`SELECT name, age FROM person WHERE name = ${name}`;
```

Nothing is sent until the first query. Values in a template are bound as typed parameters and are never interpolated into the text.

## How it works

Each statement is one RPC call: `pgsql` or `mysql` with params `[statements, vars?, options?]`. Positional parameters (`$1` for PostgreSQL, each `?` for MySQL) bind to the variables `_1` to `_n` and are bound as typed parameters by the instance. The reply holds one entry per statement with its status, command tag, row count, column metadata and rows, and the status of the session's transaction.

The packages use two transports and choose between them by what the call needs:

|                                    | HTTP                     | WebSocket                          |
| ---------------------------------- | ------------------------ | ---------------------------------- |
| One-shot queries                   | yes                      | yes                                |
| Atomic batch (`batch`)             | yes                      | yes                                |
| Interactive transactions (`begin`) | no                       | yes                                |
| Live queries (`live`)              | no                       | yes                                |
| Session settings that last         | no, sent with every call | yes, sent once per connection      |
| Cancel a running call              | abort the request        | `query_cancel` on abort or timeout |

With the default `transport: "auto"`, one-shot calls use HTTP (no handshake, the lowest latency from a cold isolate) and anything that needs a session opens a WebSocket. Pin `transport: "http"` or `transport: "ws"` to force one. A pinned `http` transport throws `UnsupportedOnTransportError` for `begin` and `live`.

## Connecting

A connection string, or an options object, resolves to one configuration.

| Form                                                  | Meaning                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `surrealdb://user:pass@host/<namespace>/<database>`   | Native form; namespace and database are in the path                                         |
| `surrealdb+http://`, `+https://`, `+ws://`, `+wss://` | Pins the scheme, and the transport for `+ws` and `+wss`; the port is kept                   |
| `postgres://user:pass@host/<database>?namespace=<ns>` | Existing PostgreSQL URL (in `@surrealdb/pg`); the path is the database, the port is ignored |
| `mysql://user:pass@host/<database>?namespace=<ns>`    | Existing MySQL URL (in `@surrealdb/mysql`); same rules                                      |

Hosts other than loopback use TLS by default. Query parameters `namespace` (or `ns`), `database` (or `db`), `transport` and `timeout` are read from the string.

```ts
connect({
    url: "surrealdb+wss://abc123.surrealdb.earth/prod/app",
    auth: { username: "root", password: "..." }, // or { token } or () => token
    transport: "auto", // "http" | "ws"
    timeout: 15_000, // default per-request timeout in milliseconds
    reconnect: { attempts: 5 }, // enabled, attempts, retryDelay, retryDelayMax, retryDelayMultiplier, retryDelayJitter
    settings: { timezone: "UTC", application_name: "api" },
    fetch, // injectable
    WebSocket, // injectable; pass `ws` on Node versions without a global WebSocket
});
```

Authentication:

- Credentials are `{ username, password }` for a system user, `{ access, variables }` for record access, `{ token }`, or a function returning any of them or a token string (called again when a token expires or the connection is re-established).
- Over HTTP, a user and password are sent as HTTP Basic on every call, which costs no extra round trip. With `authMode: "token"` the client signs in once, caches the token until it nears expiry, and shares one in-flight sign-in between concurrent calls.
- Over a WebSocket the client signs in when the connection opens, and again before the access token expires.
- A call that fails authentication in token mode is retried once with a fresh sign-in, and never more.

Settings are `SET` statements built from the `settings` option. Over a WebSocket they run once per connection, and a failing setting fails the connection's first call. Over HTTP they are prepended to every call, and their results are removed from the reply, so result indexes always line up with your own statements.

A caller `signal` and a timeout combine into one abort. Both are per call options as well as client options.

## Native API

Both packages export the same shape.

```ts
const rows = await sql`SELECT * FROM person WHERE age > ${18}`; // rows
const result = await sql.query("UPDATE person SET age = $1 WHERE id = $2", [31, "tobie"]); // full Result
const written = await sql.execute("DELETE FROM person WHERE id = $1", ["tobie"]); // same, reads better for writes
```

- A tagged template returns a lazy thenable that runs when awaited. Nested templates and `sql.raw(text)` share one placeholder counter, and `sql.raw` is the only way to put text into a statement.
- Calling `sql("...", [...])` as a plain function throws, so a misused call never sends unbound placeholders.
- Nothing is escaped or interpolated on the client; parameters always travel as variables.
- `rowMode: "array"`, `signal` and `timeout` are per call options, along with the decoding options below.

```ts
const adults = sql`age > ${18}`;
await sql`SELECT * FROM person WHERE name = ${"a"} AND ${adults} ORDER BY ${sql.raw("name")}`;
```

A text with several statements resolves to the result of its last statement, with `results` listing every statement in order.

Batch:

```ts
// One request; every statement commits or none does
const [created, count] = await sql.batch([
    sql`INSERT INTO person (id, name) VALUES (${"a"}, ${"A"})`,
    sql`SELECT count(*) FROM person`,
]);

// Per-entry errors instead of throwing on the first one
const settled = await sql.batch(["SELECT 1", "SELECT * FROM missing"], {
    atomic: false,
    throwOnError: false,
});
```

Option precedence is: call options over batch or transaction options, over client options, over defaults.

## Transactions and transports

```ts
await sql.begin(
    async (tx) => {
        await tx`UPDATE account SET balance = balance - ${10} WHERE id = ${"x"}`;
        await tx`UPDATE account SET balance = balance + ${10} WHERE id = ${"y"}`;
    },
    { isolation: "serializable", readOnly: false },
);
```

- `begin` opens a dedicated WebSocket session, runs the callback, commits, and on any throw rolls back. A failing rollback never masks the original error. The session is closed afterwards.
- Over HTTP the only transactional primitive is `batch` with `atomic`, because an HTTP request holds no transaction between calls.
- If a transaction is open when a WebSocket drops, it is lost; the driver surfaces `ConnectionLostError` and does not replay statements. Writes are never retried automatically.

## Results and value types

```ts
interface Result<Row> {
    rows: Row[];
    columns: Column[]; // name, type name, type id, nullable, table, column
    command: string; // PostgreSQL tag such as "SELECT 3"; MySQL statement kind
    rowCount: number;
    time: string; // server time for the statement
    transaction: "idle" | "active" | "failed";
    results: Result<Row>[]; // every statement of the call, in order
    // MySQL also has insertId and warnings
}
```

Values decode by the wire type of their column.

| PostgreSQL type                           | JavaScript value                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `bool`                                    | `boolean`                                                                                    |
| `int2`, `int4`, `float4`, `float8`        | `number`                                                                                     |
| `int8`                                    | `number` within the safe range, `bigint` beyond it (`bigint: "auto" \| "always" \| "never"`) |
| `numeric`                                 | exact decimal `string`                                                                       |
| `text`, `varchar`, `char`, `name`, `uuid` | `string`                                                                                     |
| `bytea`                                   | `Uint8Array`                                                                                 |
| `date`, `timestamp`, `timestamptz`        | `Date`                                                                                       |
| `time`, `timetz`, `interval`              | `string`                                                                                     |
| `json`, `jsonb`                           | parsed value                                                                                 |
| arrays                                    | arrays of the element decoding                                                               |
| `record`                                  | `RecordId` (`recordIds: "string"` keeps `table:key` text)                                    |
| `vector`                                  | `Float32Array` (`vectors: "array"` keeps number arrays)                                      |

MySQL values follow the protocol type: integers are numbers (`BIGINT` is a string beyond the safe range), `DECIMAL` is an exact string, date types are `Date` unless `dateStrings`, `JSON` is parsed. This mapping is provisional until the instance documents its MySQL value encoding.

Override decoding per client or per call with `parse: { timestamptz: (raw) => raw }` or a catch-all `cast(column, value)`.

## Errors

Every error extends `SurrealSqlError`.

| Error                                    | When                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `StatementError`                         | A statement failed; carries `sqlstate`, `errno`, `severity`, `position` and the partial `results`                                       |
| `CapabilityDeniedError`                  | The instance denies the method or the dialect route (`--deny-http postgres`, `--deny-rpc pgsql`)                                        |
| `AuthError`                              | Sign-in or token failure                                                                                                                |
| `RpcError`                               | The call itself failed; carries `code`, `kind`, `details`. A "Method not found" reply says the instance may predate the SQL RPC methods |
| `ConnectionError`, `ConnectionLostError` | Network failure; `ConnectionLostError` has `inTransaction`                                                                              |
| `AbortError`, `TimeoutError`             | The caller aborted, or the timeout elapsed                                                                                              |
| `UnknownResponseError`                   | A non-RPC reply, such as from a proxy; keeps the status and the first 4096 characters of the body                                       |
| `UnsupportedOnTransportError`            | `begin` or `live` on a transport pinned to HTTP                                                                                         |

The compatibility layers convert `StatementError` to the shape their ecosystem expects: a node-postgres `DatabaseError` with `code` (SQLSTATE), `severity`, `position`; a mysql2 error with `code`, `errno`, `sqlState`, `sqlMessage`.

## SurrealDB extras

- **SurrealQL on the same connection**, with the same namespace, database and auth: `` await sql.surql`SELECT * FROM person WHERE id = ${rid}` ``. Values are bound as variables, and record ids bind as `type::record(...)`.
- **Live queries** over a WebSocket: `for await (const message of sql.live("person")) { ... }` yields `{ action, id, result }` and kills the query when the loop ends. There is no `LISTEN` or `NOTIFY` emulation.
- **Describe** without running: `await sql.describe("SELECT name FROM person WHERE name = $1")` returns columns and parameter types.
- **Capabilities**: `await sql.capabilities()` reports whether the instance serves the method, its version, and which transport features exist.
- **Namespace and database selection**: `sql.withDatabase("other")` returns a client for another database on the same instance.
- **Record ids and vectors**: `RecordId` and `recordId("person:tobie")` for ids, `sql.vector(values)` to bind a vector parameter in `@surrealdb/pg`.

## ORM and driver compatibility

| Tool                              | Package                     | Entry point                                   |
| --------------------------------- | --------------------------- | --------------------------------------------- |
| node-postgres `Client` and `Pool` | `@surrealdb/pg`             | `Client`, `Pool`                              |
| Drizzle `node-postgres`           | `@surrealdb/pg`             | `drizzle({ client: pool as never })`          |
| Kysely `PostgresDialect`          | `@surrealdb/pg`             | `new PostgresDialect({ pool })`               |
| Prisma `@prisma/adapter-pg`       | `@surrealdb/pg`             | `new pg.Pool({ connectionString, Client })`   |
| mysql2 promise API                | `@surrealdb/mysql`          | `createPool`, `createConnection`              |
| Drizzle `mysql2`                  | `@surrealdb/mysql`          | `drizzle(pool as never, { mode: "default" })` |
| Kysely `MysqlDialect`             | `@surrealdb/mysql/callback` | `new MysqlDialect({ pool })`                  |
| `@neondatabase/serverless`        | `@surrealdb/pg/neon`        | `neon`, `Pool`, `Client`, `neonConfig`        |
| Drizzle `neon-http`               | `@surrealdb/pg/neon`        | `drizzle(neon(url))`, with the import aliased |
| Drizzle `neon-serverless`         | `@surrealdb/pg/neon`        | `drizzle({ client: pool })`, aliased          |
| `@planetscale/database`           | `@surrealdb/mysql/planetscale` | `Client`, `connect`, `cast`, `format`      |
| Drizzle `planetscale-serverless`  | `@surrealdb/mysql/planetscale` | `drizzle(new Client({ url }))`, aliased    |

```ts
// Drizzle on PostgreSQL
import { Pool } from "@surrealdb/pg";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString });
const db = drizzle({ client: pool as never });
```

```ts
// Prisma: the adapter needs a real pg.Pool, so give pg our Client
import pg from "pg";
import { Client } from "@surrealdb/pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString, Client });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
```

```ts
// Kysely on MySQL
import { createPool } from "@surrealdb/mysql/callback";
import { Kysely, MysqlDialect } from "kysely";

const db = new Kysely({ dialect: new MysqlDialect({ pool: createPool({ uri }) as never }) });
```

Notes:

- The adapters' types name `pg`'s and `mysql2`'s own classes, so pass the pool with `as never` (or cast to the class they ask for).
- `pg` is an optional peer dependency of `@surrealdb/pg`, used only for the `new pg.Pool({ Client })` path. Drizzle's node-postgres driver and Prisma import `pg` themselves, so their users install it regardless.
- In the node-postgres layer, values travel in the dialect's text form and go through `types.getTypeParser`, so Drizzle's parser overrides (timestamps, dates, intervals as text) apply unchanged.
- `Pool.query()` runs over HTTP when the transport is `auto`. Pooled clients from `connect()` are WebSocket sessions, and `release()` rolls back an open transaction before a client is reused.
- Not provided: cursors, `COPY`, binary format, `LISTEN` and `NOTIFY`, `pg-native`, mysql2 streaming and `LOAD DATA LOCAL`. Kysely streaming is therefore unavailable.
- Neon and PlanetScale code moves over by changing the import to `@surrealdb/pg/neon` or `@surrealdb/mysql/planetscale`. Drizzle's `neon-http`, `neon-serverless` and `planetscale-serverless` drivers import the vendors' packages by name and check their classes, so alias `@neondatabase/serverless` to `@surrealdb/pg/neon` and `@planetscale/database` to `@surrealdb/mysql/planetscale` in your bundler. The package READMEs show how and list what each entry point honours and ignores.
- Not supported: `@prisma/adapter-neon`, `@prisma/adapter-planetscale` and Kysely's PlanetScale dialect, which construct the vendors' own classes. Prisma's MySQL driver adapters have not been assessed.

## Runtimes and bundle size

The packages use `fetch`, `WebSocket`, `AbortController` and `TextEncoder`, and no Node built-ins, so they run on Node 20 and later, Bun, Deno, Cloudflare Workers, Vercel Edge and browsers. Node versions without a global `WebSocket` need a constructor passed as the `WebSocket` option (for example from `ws`); HTTP alone needs nothing extra. The packages are ESM only.

Each package is about 11 kB minified and brotlied, with a budget of 13 kB enforced by `size-limit`. A test checks the built output for `node:` imports, `Buffer`, and references to the unpublished internal package, and that class names survive the build, because Drizzle detects a pool by its constructor name.

Do not put database credentials in browser code that real users can read. The packages accept a token or a function returning one for exactly that reason.

## Repository layout

```
packages/
  internal/   @surrealdb/sql-internal  config, transports, auth, session runner, statements, errors
              (private, bundled into the public packages)
  pg/         @surrealdb/pg            native API and node-postgres layer
  mysql/      @surrealdb/mysql         native API, mysql2 promise layer, callback pool
docs/         DESIGN.md, COMPATIBILITY.md
test-support/ PGlite and SQLite contract simulators, server launcher for integration tests
```

## Development

The repository uses bun workspaces, biome, tsup with dts-bundle-generator, vitest and size-limit, and is licensed Apache-2.0 like the other SurrealDB JavaScript repositories.

```bash
bun install
bun run qc              # biome
bun run qts             # typecheck (run bun run prisma:generate first)
bun run build           # both packages
bun run test            # unit tests (build first for the built-output checks)
bun run test:compat     # generates the Prisma client, then runs the adapter suites
bun run size            # bundle size budgets
```

Integration tests need a `surreal` binary that serves the `pgsql` and `mysql` RPC methods. Point `SURREAL_BIN` at it, or build it in the engine checkout next to this repository:

```bash
cargo build --locked --no-default-features --features storage-mem,http,scripting,postgres,mysql
SURREAL_BIN=/path/to/surreal bun run test:integration
```

A binary built before the methods landed answers "Method not found", and the first integration test fails with that message instead of skipping.

Continuous integration runs code quality and typecheck, unit tests, the adapter suites, and the size budgets on every pull request. A separate integration workflow runs the server suites when the repository variable `SURREAL_BIN_URL` points at a downloadable binary.

The contract simulators in `test-support/` are not a substitute for a server: one connection serves every session, so tests that hold transactions on two sessions at once are not supported, and the MySQL simulator is SQLite.

## Design documents

- [docs/DESIGN.md](docs/DESIGN.md): goals, the transport contract, package layout, API design, connection configuration, extras, compatibility layer design, tooling, test strategy, credits for borrowed ideas, implementation status and open decisions.
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md): how each adapter is verified, against what, and which versions were read.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## Licence

Apache-2.0. These packages are original work. They borrow ideas, credited in the design document, from `@neondatabase/serverless` and `@planetscale/database` and contain none of their code.
