# @surrealdb/pg

A PostgreSQL-dialect client for SurrealDB that runs where TCP is not available: Cloudflare Workers, Vercel Edge, browsers, Deno, Bun and Node 20 and later. It sends PostgreSQL text to an instance over the `pgsql` RPC method, on HTTP for one-shot work and on a WebSocket for sessions.

It has two layers. The native API is a tagged template plus `query`, `execute`, `batch` and `begin`. The compatibility layer is a node-postgres style `Client` and `Pool`, which lets Drizzle, Kysely and Prisma run on top of it.

For native drivers over TCP (`pg`, and others), use the PostgreSQL wire listener of the instance instead. For other dialects and the overall design, see the [repository README](../../README.md) and [docs/DESIGN.md](../../docs/DESIGN.md).

- [Status](#status)
- [Install](#install)
- [Native API](#native-api)
- [Options](#options)
- [Results](#results)
- [Values](#values)
- [Batch and transactions](#batch-and-transactions)
- [Errors](#errors)
- [SurrealDB extras](#surrealdb-extras)
- [Connection](#connection)
- [node-postgres compatibility](#node-postgres-compatibility)
- [Neon drop-in](#neon-drop-in)
- [Drizzle, Kysely and Prisma](#drizzle-kysely-and-prisma)
- [Runtimes](#runtimes)
- [Exports](#exports)
- [Limits](#limits)

## Status

The instance side of the `pgsql` method is in development. Until a server build ships it, this package is verified against a contract simulator backed by a real PostgreSQL (PGlite), with real Drizzle, Kysely, `pg.Pool` and Prisma `adapter-pg` code. Nothing has run against a real SurrealDB server yet. See [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

## Install

```bash
npm install @surrealdb/pg
```

The package is ESM only and has no runtime dependencies. `pg` is an optional peer dependency, needed only for the Prisma path described below.

## Native API

```ts
import { connect } from "@surrealdb/pg";

const sql = connect("postgres://root:root@abc123.surrealdb.earth/app?namespace=prod");

// Tagged template: values become bound parameters, rows come back
const rows = await sql`SELECT name, age FROM person WHERE name = ${name} AND age > ${18}`;

// Full result: columns, command tag and row count
const result = await sql.query("UPDATE person SET age = $1 WHERE id = $2", [31, "tobie"]);
console.log(result.command, result.rowCount);

// Same as query; reads better for writes
await sql.execute("DELETE FROM person WHERE id = $1", ["tobie"]);

// Nested templates and trusted raw text share one placeholder counter
const adults = sql`age > ${18}`;
await sql`SELECT * FROM person WHERE ${adults} ORDER BY ${sql.raw("name")}`;
```

Nothing is sent until the first query. A tagged template is a lazy thenable: it runs when awaited, and `batch` collects statements without running them.

Rules that keep parameters safe:

- Values always travel as variables (`_1` to `_n`) and are bound as typed parameters by the instance. Nothing is escaped or interpolated on the client.
- `sql.raw(text)` splices trusted text verbatim and is the only way to put text into a statement.
- Calling `sql("...", [...])` as a plain function throws, so a misused call never sends unbound placeholders.
- A statement built with `query(text, params)` cannot be nested inside a template, because its placeholders are already numbered.
- `undefined` binds as `null`; `Date` binds as an ISO string; `bigint` binds as a number inside the safe range and a decimal string beyond it; `Uint8Array` binds as base64 text; arrays and objects bind as JSON.

## Options

Client options (`connect(url | options)`), in addition to the connection options below:

| Option      | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `bigint`    | `"auto"` (default), `"always"` or `"never"`; see [Values](#values) |
| `recordIds` | `"record"` (default) or `"string"`                                 |
| `vectors`   | `"float32"` (default) or `"array"`                                 |
| `parse`     | Decoders by type name, for example `{ timestamptz: (raw) => raw }` |
| `cast`      | Catch-all `(column, value) => value`, applied last                 |

Per-call options (the last argument of `query` and `execute`, and of `batch` and `begin`):

| Option                     | Meaning                                    |
| -------------------------- | ------------------------------------------ |
| `rowMode`                  | `"object"` (default) or `"array"`          |
| `signal`                   | An `AbortSignal` that cancels the call     |
| `timeout`                  | Milliseconds; overrides the client default |
| the decoding options above | Override the client's for this call        |

Precedence is: call options over batch or transaction options, over client options, over defaults.

## Results

```ts
interface Result<Row> {
    rows: Row[];
    columns: Column[]; // { name, typeName, oid, type, nullable, table, column }
    command: string; // the PostgreSQL command tag, for example "SELECT 3" or "INSERT 0 1"
    rowCount: number;
    time: string; // server time for the statement
    transaction: "idle" | "active" | "failed";
    results: Result<Row>[]; // every statement of the call, in order
}
```

A text with several statements resolves to the result of its last statement, and `results` lists them all.

Column metadata comes from the instance as the PostgreSQL wire reports it, so `oid` is a built-in PostgreSQL type id, and `nullable` is `null` because the PostgreSQL wire does not carry it. `sql.describe(text)` returns the same column metadata and the parameter types without running the statement.

## Values

Values decode by the wire type of their column:

| PostgreSQL type                           | JavaScript value                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bool`                                    | `boolean`                                                                                                                            |
| `int2`, `int4`, `float4`, `float8`        | `number`                                                                                                                             |
| `int8`                                    | `number` within the safe range, `bigint` beyond it; `bigint: "always"` returns `bigint` for every `int8`, `"never"` returns `number` |
| `numeric`                                 | exact decimal `string`                                                                                                               |
| `text`, `varchar`, `char`, `name`, `uuid` | `string`                                                                                                                             |
| `bytea`                                   | `Uint8Array`                                                                                                                         |
| `date`, `timestamp`, `timestamptz`        | `Date` (a `timestamp` without a zone is read as UTC)                                                                                 |
| `time`, `timetz`, `interval`              | `string`                                                                                                                             |
| `json`, `jsonb`                           | parsed value                                                                                                                         |
| arrays                                    | arrays of the element decoding                                                                                                       |
| `record`                                  | `RecordId` with `table`, `key` and `toString()`; `recordIds: "string"` keeps `table:key` text                                        |
| `vector`                                  | `Float32Array`; `vectors: "array"` keeps number arrays                                                                               |

Use `parse` to take over one type, or `cast` to see every value:

```ts
const sql = connect({
    url,
    parse: { timestamptz: (raw) => raw }, // keep ISO text
    cast: (column, value) => (column.name === "secret" ? "[redacted]" : value),
});
```

`RecordId.parse("person:tobie")` and `recordId("person:tobie")` build ids; a `RecordId` bound as a parameter is sent in its `table:key` form.

## Batch and transactions

```ts
// One HTTP request; every statement commits or none does
const [created, count] = await sql.batch([
    sql`INSERT INTO person (id, name) VALUES (${"a"}, ${"A"})`,
    sql`SELECT count(*) FROM person`,
]);

// Per-entry errors instead of throwing on the first one
const settled = await sql.batch(["SELECT 1", "SELECT * FROM missing"], {
    atomic: false,
    throwOnError: false,
});

// Interactive transaction on a dedicated WebSocket session
await sql.begin(
    async (tx) => {
        await tx`UPDATE account SET balance = balance - ${10} WHERE id = ${"x"}`;
        await tx`UPDATE account SET balance = balance + ${10} WHERE id = ${"y"}`;
    },
    { isolation: "serializable", readOnly: false },
);
```

- `batch` is atomic by default and resolves one result per entry, in order. Entries are statements, strings or `{ text, params }` objects.
- `begin` opens a dedicated WebSocket session, sends `BEGIN`, runs the callback, sends `COMMIT`, and on any throw sends `ROLLBACK`. A failing rollback never masks the original error. The session is closed afterwards.
- An HTTP request holds no transaction between calls, so interactive transactions, live queries and settings that last for the session need the WebSocket. With the default `transport: "auto"`, one-shot calls use HTTP and `begin` opens a WebSocket for its length. With `transport: "http"` pinned, `begin` and `live` throw `UnsupportedOnTransportError`.
- If a WebSocket drops with a transaction open, the transaction is lost: the call fails with `ConnectionLostError` (`inTransaction: true`) and the driver does not replay statements. Writes are never retried automatically.

## Errors

Every error extends `SurrealSqlError` and is exported.

| Error                                    | When                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `StatementError`                         | A statement failed. Has `sqlstate`, `severity`, `position`, `errno` and the partial `results`                               |
| `CapabilityDeniedError`                  | The instance denies the method or the route (`--deny-http postgres`, `--deny-rpc pgsql`)                                    |
| `AuthError`                              | Sign-in or token failure                                                                                                    |
| `RpcError`                               | The call itself failed. Has `code`, `kind`, `details`. "Method not found" says the instance may predate the SQL RPC methods |
| `ConnectionError`, `ConnectionLostError` | Network failure                                                                                                             |
| `AbortError`, `TimeoutError`             | The caller aborted, or the timeout elapsed                                                                                  |
| `UnknownResponseError`                   | A non-RPC reply such as a proxy page; keeps the status and the first 4096 characters                                        |
| `UnsupportedOnTransportError`            | `begin` or `live` on a transport pinned to HTTP                                                                             |

```ts
try {
    await sql`SELECT * FROM missing`;
} catch (error) {
    if (error instanceof StatementError && error.sqlstate === "42P01") {
        // the relation does not exist
    }
}
```

The node-postgres layer raises `DatabaseError` instead, with `code` (the SQLSTATE), `severity`, `message` and `position`.

## SurrealDB extras

```ts
// SurrealQL on the same connection, namespace, database and auth
const [people] = await sql.surql`SELECT * FROM person WHERE age > ${18}`;

// Live queries over a WebSocket; the query is killed when the loop ends
for await (const message of sql.live("person")) {
    console.log(message.action, message.id, message.result);
}

// Column and parameter metadata without running the statement
const { columns, params } = await sql.describe("SELECT name FROM person WHERE name = $1");

// Whether the instance serves the method, its version, and the transport features
console.log(await sql.capabilities());

// A client for another database on the same instance
const other = sql.withDatabase("archive");

// A vector parameter for a pgvector-style column
await sql`SELECT id FROM item ORDER BY embedding <-> ${sql.vector([0.1, 0.2, 0.3])} LIMIT 5`;

await sql.close();
```

- `surql` binds each value as a variable; a `RecordId` binds as `type::record(...)`. The result is one entry per SurrealQL statement.
- `live` yields `{ action, id, result }` and throws if the WebSocket drops. `LISTEN` and `NOTIFY` are not emulated.
- `capabilities()` returns `{ supported, reason?, version?, transport }`. It reports `supported: false` with a reason when the method or the PostgreSQL route is denied.

## Connection

```ts
connect({
    url: "surrealdb+wss://abc123.surrealdb.earth/prod/app",
    auth: { username: "root", password: "..." }, // or { token } or () => token
    transport: "auto", // "http" | "ws"
    timeout: 15_000,
    reconnect: { attempts: 5 },
    settings: { timezone: "UTC", application_name: "api" },
    fetch, // injectable
    WebSocket, // injectable; pass `ws` on Node versions without a global WebSocket
});
```

Connection strings:

| Form                                                  | Meaning                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `surrealdb://user:pass@host/<namespace>/<database>`   | Native form                                                                  |
| `surrealdb+http://`, `+https://`, `+ws://`, `+wss://` | Pins the scheme (and the transport for `+ws` and `+wss`); the port is kept   |
| `postgres://user:pass@host/<database>?namespace=<ns>` | An existing PostgreSQL URL: the path is the database and the port is ignored |

Hosts other than loopback use TLS by default. `namespace` (or `ns`), `database` (or `db`), `transport` and `timeout` are read from the query string.

- Credentials are `{ username, password }`, `{ access, variables }` for record access, `{ token }`, or a function returning any of them or a token string. The function is called again when a token expires or the connection is re-established.
- Over HTTP, a user and password are sent as HTTP Basic on every call, which costs no extra round trip. `authMode: "token"` signs in once instead, caches the token until it nears expiry, and shares one in-flight sign-in between concurrent calls. A call that fails authentication in token mode is retried once with a fresh sign-in.
- Over a WebSocket the client signs in when the connection opens and again before the access token expires.
- `reconnect` takes `enabled`, `attempts`, `retryDelay`, `retryDelayMax`, `retryDelayMultiplier` and `retryDelayJitter`, with exponential backoff and jitter.
- `settings` become `SET` statements. Over a WebSocket they run once per connection, and a failing setting fails the first call. Over HTTP they are prepended to every call and their results are removed from the reply, because the instance keeps settings for the request only over HTTP.
- `timeout` and a caller `signal` combine into one abort. Over a WebSocket an abort sends `query_cancel` for that request; over HTTP it aborts the request.
- `search_path` is a stored setting only; it never selects a namespace or database. Use the connection string, `namespace` and `database`, or `withDatabase`.

## node-postgres compatibility

```ts
import { Client, Pool, types, DatabaseError } from "@surrealdb/pg";

const pool = new Pool({
    connectionString: "postgres://root:root@abc123.surrealdb.earth/app?namespace=prod",
});

const { rows, rowCount, command, fields } = (await pool.query(
    "SELECT id, name FROM person WHERE name = $1",
    ["Tobie"],
)) as any;

const client = await pool.connect();
try {
    await client.query("BEGIN");
    await client.query("UPDATE account SET balance = balance - 10 WHERE id = $1", ["x"]);
    await client.query("COMMIT");
} catch (error) {
    await client.query("ROLLBACK");
    throw error;
} finally {
    client.release();
}
await pool.end();
```

`Client` and `Pool` follow the node-postgres surface that the adapters use.

- **Query forms.** `query(text, values?)`, `query({ text, values, rowMode, types, query_timeout }, values?)`, and the callback forms. A text with several statements resolves to an array of results, as in node-postgres.
- **Result.** `{ command, rowCount, oid, rows, fields }` with `fields` entries `{ name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format }`. `command` and `rowCount` come from the command tag, so `INSERT 0 5` gives `INSERT` and 5. Unknown type ids are reported as text (25).
- **Values.** Queries use the dialect's text form and each cell goes through `types.getTypeParser(oid)` or the `types` of the query config, as node-postgres does. `int8` and `numeric` stay strings, as in node-postgres, and `timestamp` without a zone is read as local time.
- **`types`.** `types.getTypeParser(oid)`, `types.setTypeParser(oid, parser)` and `types.builtins`, with the methods usable detached from the object. `TypeOverrides` gives per-instance overrides.
- **Client.** `connect()`, `end()`, `query()`, `processID`, and the events `connect`, `end` and `error`. A `Client` is one WebSocket session unless the configuration pins HTTP. Config takes `connectionString`, `user`, `password`, `host`, `port`, `database`, `ssl`, `query_timeout`, `statement_timeout`, `application_name` and `types`, plus any option from [Connection](#connection). With `host` and `port` and no `ssl` the client uses `http`; with `ssl` it uses `https`; with `host` alone it uses the default of the host.
- **Pool.** `connect()`, `query()`, `end()`, `totalCount`, `idleCount`, `waitingCount`, `options`, and the events `connect`, `acquire`, `release`, `remove` and `error`. Options: `max` (default 10), `idleTimeoutMillis` (default 10000), `Client` (the class to build) and `poolQueryViaHttp` (default `true`).
- **`pool.query()`** runs over stateless HTTP when the transport is `auto`, so a cold edge isolate needs no handshake. Pooled clients from `pool.connect()` are WebSocket sessions. `release()` rolls back an open transaction before a client is reused, and drops a client released with an error.
- **`DatabaseError`.** Statement failures raise an error with `code` (the SQLSTATE), `severity`, `message` and `position`.

## Neon drop-in

`@surrealdb/pg/neon` has the surface of `@neondatabase/serverless`, so code written for Neon moves over by changing the import:

```diff
- import { neon, Pool, Client, neonConfig } from "@neondatabase/serverless";
+ import { neon, Pool, Client, neonConfig } from "@surrealdb/pg/neon";
```

```ts
import { neon } from "@surrealdb/pg/neon";

const sql = neon("postgres://root:root@abc123.surrealdb.earth/app?ns=prod");

const rows = await sql`SELECT * FROM person WHERE name = ${name}`;
const one = await sql.query("SELECT * FROM person WHERE id = $1", [id], { fullResults: true });
const [created, total] = await sql.transaction([
    sql`INSERT INTO person (name) VALUES (${name}) RETURNING id`,
    sql`SELECT count(*) AS n FROM person`,
]);
```

- `neon(connectionString, options)` takes `arrayMode`, `fullResults`, `authToken` (a string or a function), `fetchOptions`, `fetchFunction`, `isolationLevel`, `readOnly` and `deferrable`. Calling `sql(text, params)` as a plain function throws, as in Neon; use `sql.query(text, params, options)`. `sql.unsafe(text)` splices trusted text into a template.
- Queries are lazy thenables: they are sent when awaited, once, or when passed to `sql.transaction`. A transaction is one atomic HTTP call; it also takes a function of a query builder, which is used like `sql`: `sql.transaction((txn) => [txn.query(text, params)])`. Each query in it must be one statement.
- `fullResults` returns `{ fields, command, rowCount, rows, rowAsArray, viaNeonFetch }`. Values are parsed with the node-postgres type parsers, so `types.setTypeParser` applies, as it does with Neon.
- A failed statement throws `NeonDbError`, a `DatabaseError` carrying `code` (the SQLSTATE), `severity`, `position` and the other node-postgres fields.
- The connection string follows the rules in [Connection](#connection). Neon has no namespaces, so the SurrealDB namespace comes from the `ns` (or `namespace`) parameter; the path is the database. `sslmode` and similar parameters are ignored, and TLS follows the host (off for loopback only).
- `neonConfig` is honoured for `fetchFunction`, `fetchEndpoint` (a URL, or a function of host and port; the target must speak the RPC contract, not Neon's `/sql` protocol) and `webSocketConstructor` (used by the `Client` and `Pool` of this entry point). It accepts and ignores `wsProxy`, `useSecureWebSocket`, `pipelineConnect`, `pipelineTLS`, `coalesceWrites`, `forceDisablePgSSL`, `disableSNI`, `fetchConnectionCache`, `poolQueryViaFetch`, `subtls` and `rootCerts`, which describe Neon's wire protocol and proxies.
- `isolationLevel` and `readOnly`: an atomic call has no option for them, so `readOnly: true` and `"Serializable"` throw `UnsupportedOnTransportError` instead of being ignored. The other levels are accepted and the call runs at the isolation of an atomic call. `deferrable` is ignored.
- `Pool` and `Client` are the node-postgres layer above, reading their WebSocket class from `neonConfig.webSocketConstructor` unless given one. `pool.query()` runs over HTTP regardless of `neonConfig.poolQueryViaFetch`. `types`, `DatabaseError`, `escapeIdentifier` and `escapeLiteral` are exported too.

To use Drizzle's `neon-http` or `neon-serverless` drivers, which import `@neondatabase/serverless` by name, point that name at this entry point in your bundler instead of installing Neon's package:

```ts
// vite.config.ts, or the equivalent alias of esbuild, webpack, tsconfig paths, wrangler.toml [alias]
resolve: { alias: { "@neondatabase/serverless": "@surrealdb/pg/neon" } }
```

```ts
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@surrealdb/pg/neon";

const db = drizzle(neon(connectionString));
```

`db.batch()` becomes one atomic call. Drizzle's `neon-http` refuses interactive transactions, as it does on Neon; `neon-serverless` runs them over the WebSocket `Pool`.

## Drizzle, Kysely and Prisma

Drizzle:

```ts
import { Pool } from "@surrealdb/pg";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString });
const db = drizzle({ client: pool as never });
```

Drizzle detects a pool by its constructor name, and the built output keeps it. Drizzle's timestamp, date and interval parsers return text, and they apply because values go through `types.getTypeParser`. Transactions pin one pooled connection and use savepoints for nesting. The migrator works.

Kysely:

```ts
import { Pool } from "@surrealdb/pg";
import { Kysely, PostgresDialect } from "kysely";

const db = new Kysely({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) as never }),
});
```

Kysely reads `command` for affected-row counts, and both are set.

Prisma needs a real `pg.Pool` instance. Give `pg` our client:

```ts
import pg from "pg";
import { Client } from "@surrealdb/pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

const pool = new pg.Pool({ connectionString, Client });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
```

Notes:

- Install `pg` for Drizzle and Prisma. Drizzle's node-postgres driver and Prisma's adapter import it themselves.
- The adapters' types name `pg`'s classes, so pass `pool as never` where they ask for one.
- Prisma rejects an unknown type id below 16384, so the instance must report built-in PostgreSQL type ids. This is checked against the simulator and has to be checked against a server.
- Not supported: `@prisma/adapter-neon`, which constructs Neon's own classes. Drizzle `neon-http` and `neon-serverless` work through the [Neon drop-in](#neon-drop-in).

## Runtimes

The package uses `fetch`, `WebSocket`, `AbortController` and `TextEncoder`, and no Node built-ins. It runs on Node 20 and later, Bun, Deno, Cloudflare Workers, Vercel Edge and browsers. Node versions without a global `WebSocket` need a constructor passed as the `WebSocket` option; HTTP alone needs nothing extra. The native entry is about 11 kB minified and brotlied.

Do not put database credentials in browser code that real users can read. Use a token, or a function that returns one.

## Exports

- Native: `connect`, `RecordId`, `recordId`, `decodeNative`, `builtins`, `settingStatements`, and the types `SqlClient`, `Queryable`, `Result`, `Column`, `QueryOptions`, `BatchOptions`, `TransactionOptions`, `LiveMessage`, `Capabilities`, `PgConnectOptions`, `DecodeOptions`.
- node-postgres layer: `Client`, `Pool`, `DatabaseError`, `types`, `TypeOverrides`, and the types `ClientConfig`, `PoolConfig`, `PoolClient`, `QueryConfig`, `QueryResult`, `FieldDef`.
- `@surrealdb/pg/neon`: `neon`, `neonConfig`, `NeonDbError`, `NeonQueryPromise`, `Client`, `Pool`, `DatabaseError`, `types`, `escapeIdentifier`, `escapeLiteral`, and the types `NeonQueryFunction`, `FullQueryResults`, `HTTPQueryOptions`, `HTTPTransactionOptions`, `NeonConfig`. The package root also exports `neon`, `neonConfig` and `NeonDbError`.
- Errors: `SurrealSqlError`, `StatementError`, `CapabilityDeniedError`, `AuthError`, `RpcError`, `ConnectionError`, `ConnectionLostError`, `AbortError`, `TimeoutError`, `UnknownResponseError`, `UnsupportedOnTransportError`.

## Limits

- Not provided in the node-postgres layer: cursors, `COPY`, binary format, `LISTEN` and `NOTIFY`, and `pg-native`. Kysely streaming is therefore unavailable.
- Not built yet: CBOR transport, a browser warning for credentials, and interval helpers.
- The shapes of `query_cancel` and `describe` replies are provisional until the instance documents them.

## Licence

Apache-2.0.
