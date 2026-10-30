# @surrealdb/mysql

A MySQL-dialect client for SurrealDB that runs where TCP is not available: Cloudflare Workers, Vercel Edge, browsers, Deno, Bun and Node 20 and later. It sends MySQL text to an instance over the `mysql` RPC method, on HTTP for one-shot work and on a WebSocket for sessions.

It has two layers. The native API is a tagged template plus `query`, `execute`, `batch` and `begin`. The compatibility layer is a `mysql2/promise` style `createPool` and `createConnection`, plus a callback pool, which lets Drizzle and Kysely run on top of it.

For native drivers over TCP (`mysql2`, and others), use the MySQL wire listener of the instance instead. For the overall design, see the [repository README](../../README.md) and [docs/DESIGN.md](../../docs/DESIGN.md).

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
- [mysql2 compatibility](#mysql2-compatibility)
- [PlanetScale drop-in](#planetscale-drop-in)
- [Drizzle and Kysely](#drizzle-and-kysely)
- [Runtimes](#runtimes)
- [Exports](#exports)
- [Limits](#limits)

## Status

The instance side of the `mysql` method is in development. Until a server build ships it, this package is verified against a contract simulator and not against a real server. The simulator is SQLite, so the adapter suites check call forms and result shapes, not MySQL semantics. The native value encoding for MySQL columns is provisional until the instance documents it. See [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

## Install

```bash
npm install @surrealdb/mysql
```

The package is ESM only and has no runtime dependencies.

## Native API

```ts
import { connect } from "@surrealdb/mysql";

const sql = connect("mysql://root:root@abc123.surrealdb.earth/app?namespace=prod");

// Tagged template: values become bound parameters, rows come back
const rows = await sql`SELECT name, age FROM person WHERE name = ${name} AND age > ${18}`;

// Full result: columns, statement kind, row count and insert id
const result = await sql.query("UPDATE person SET age = ? WHERE id = ?", [31, "tobie"]);
console.log(result.command, result.rowCount, result.insertId);

// Same as query; reads better for writes
await sql.execute("DELETE FROM person WHERE id = ?", ["tobie"]);

// Nested templates and trusted raw text share one placeholder list
const adults = sql`age > ${18}`;
await sql`SELECT * FROM person WHERE ${adults} ORDER BY ${sql.raw("name")}`;
```

Nothing is sent until the first query. A tagged template is a lazy thenable: it runs when awaited, and `batch` collects statements without running them.

Rules that keep parameters safe:

- Values always travel as variables (`_1` to `_n`, in the order of the `?` placeholders) and are bound as typed parameters by the instance. Nothing is escaped or interpolated on the client.
- `sql.raw(text)` splices trusted text verbatim and is the only way to put text into a statement.
- Calling `sql("...", [...])` as a plain function throws, so a misused call never sends unbound placeholders.
- A statement built with `query(text, params)` cannot be nested inside a template.
- `undefined` binds as `null`; `Date` binds as an ISO string; `bigint` binds as a number inside the safe range and a decimal string beyond it; `Uint8Array` binds as base64 text; arrays and objects bind as JSON.

## Options

Client options (`connect(url | options)`), in addition to the connection options below:

| Option           | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `bigint`         | `"auto"` (default), `"string"` or `"bigint"` for `BIGINT` columns   |
| `dateStrings`    | Return `DATE`, `DATETIME` and `TIMESTAMP` as text instead of `Date` |
| `decimalNumbers` | Return `DECIMAL` as numbers instead of exact strings                |
| `cast`           | Catch-all `(column, value) => value`, applied last                  |

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
    columns: Column[]; // { name, typeName, mysqlType, nullable, table, column }
    command: string; // the statement kind, for example "SELECT" or "INSERT"
    rowCount: number; // rows read, or rows affected by a write
    insertId: number | string | null;
    warnings: number;
    time: string; // server time for the statement
    transaction: "idle" | "active" | "failed";
    results: Result<Row>[]; // every statement of the call, in order
}
```

A text with several statements resolves to the result of its last statement, and `results` lists them all. `nullable` comes from the column's `NOT NULL` flag. `sql.describe(text)` returns column metadata and parameter types without running the statement.

## Values

Values decode by the protocol type of their column. This mapping is provisional until the instance documents its MySQL value encoding.

| MySQL type                               | JavaScript value                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TINY`, `SHORT`, `LONG`, `INT24`, `YEAR` | `number`                                                                                                                            |
| `LONGLONG`                               | `number` within the safe range, a `string` beyond it; `bigint: "string"` always returns text and `"bigint"` always returns `bigint` |
| `FLOAT`, `DOUBLE`                        | `number`                                                                                                                            |
| `DECIMAL`, `NEWDECIMAL`                  | exact decimal `string`; `decimalNumbers` returns numbers                                                                            |
| `DATE`, `DATETIME`, `TIMESTAMP`          | `Date`, read as local time; `dateStrings` returns text; zero dates stay as their text                                               |
| `JSON`                                   | parsed value                                                                                                                        |
| `VECTOR`                                 | `Float32Array`                                                                                                                      |
| everything else                          | `string`                                                                                                                            |

Text-protocol values and native JSON values are both accepted, so the same decoder serves the native layer and the mysql2 layer.

```ts
const sql = connect({
    url,
    dateStrings: true,
    cast: (column, value) => (column.name === "secret" ? "[redacted]" : value),
});
```

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
- `begin` opens a dedicated WebSocket session, sends `START TRANSACTION` (after `SET TRANSACTION ISOLATION LEVEL` when an isolation level is given), runs the callback, sends `COMMIT`, and on any throw sends `ROLLBACK`. A failing rollback never masks the original error. The session is closed afterwards.
- An HTTP request holds no transaction between calls, so interactive transactions, live queries and settings that last for the session need the WebSocket. With the default `transport: "auto"`, one-shot calls use HTTP and `begin` opens a WebSocket for its length. With `transport: "http"` pinned, `begin` and `live` throw `UnsupportedOnTransportError`.
- If a WebSocket drops with a transaction open, the transaction is lost: the call fails with `ConnectionLostError` (`inTransaction: true`) and the driver does not replay statements. Writes are never retried automatically.

## Errors

Every error extends `SurrealSqlError` and is exported.

| Error                                    | When                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `StatementError`                         | A statement failed. Has `errno`, `sqlstate`, `severity`, `position` and the partial `results`                               |
| `CapabilityDeniedError`                  | The instance denies the method or the route (`--deny-http mysql`, `--deny-rpc mysql`)                                       |
| `AuthError`                              | Sign-in or token failure                                                                                                    |
| `RpcError`                               | The call itself failed. Has `code`, `kind`, `details`. "Method not found" says the instance may predate the SQL RPC methods |
| `ConnectionError`, `ConnectionLostError` | Network failure                                                                                                             |
| `AbortError`, `TimeoutError`             | The caller aborted, or the timeout elapsed                                                                                  |
| `UnknownResponseError`                   | A non-RPC reply such as a proxy page; keeps the status and the first 4096 characters                                        |
| `UnsupportedOnTransportError`            | `begin` or `live` on a transport pinned to HTTP                                                                             |

The mysql2 layer raises `MysqlError` instead, with `code` (for example `ER_DUP_ENTRY`), `errno`, `sqlState`, `sqlMessage` and `sql`. Codes are named for the common numbers (1045, 1048, 1049, 1050, 1051, 1054, 1062, 1064, 1146, 1205, 1213, 1216, 1217, 1317, 1451, 1452); any other number gets `ER_UNKNOWN` with the number in `errno`.

## SurrealDB extras

```ts
// SurrealQL on the same connection, namespace, database and auth
const [people] = await sql.surql`SELECT * FROM person WHERE age > ${18}`;

// Live queries over a WebSocket; the query is killed when the loop ends
for await (const message of sql.live("person")) {
    console.log(message.action, message.id, message.result);
}

// Column and parameter metadata without running the statement
const { columns, params } = await sql.describe("SELECT name FROM person WHERE name = ?");

// Whether the instance serves the method, its version, and the transport features
console.log(await sql.capabilities());

// A client for another database on the same instance
const other = sql.withDatabase("archive");

await sql.close();
```

- `surql` binds each value as a variable. The result is one entry per SurrealQL statement.
- `live` yields `{ action, id, result }` and throws if the WebSocket drops.
- `capabilities()` returns `{ supported, reason?, version?, transport }`. It reports `supported: false` with a reason when the method or the MySQL route is denied.

## Connection

```ts
connect({
    url: "surrealdb+wss://abc123.surrealdb.earth/prod/app",
    auth: { username: "root", password: "..." }, // or { token } or () => token
    transport: "auto", // "http" | "ws"
    timeout: 15_000,
    reconnect: { attempts: 5 },
    settings: { time_zone: "+00:00", sql_mode: "ANSI_QUOTES" },
    fetch, // injectable
    WebSocket, // injectable; pass `ws` on Node versions without a global WebSocket
});
```

Connection strings:

| Form                                                  | Meaning                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `surrealdb://user:pass@host/<namespace>/<database>`   | Native form                                                                |
| `surrealdb+http://`, `+https://`, `+ws://`, `+wss://` | Pins the scheme (and the transport for `+ws` and `+wss`); the port is kept |
| `mysql://user:pass@host/<database>?namespace=<ns>`    | An existing MySQL URL: the path is the database and the port is ignored    |

Hosts other than loopback use TLS by default. `namespace` (or `ns`), `database` (or `db`), `transport` and `timeout` are read from the query string.

- Credentials are `{ username, password }`, `{ access, variables }` for record access, `{ token }`, or a function returning any of them or a token string. The function is called again when a token expires or the connection is re-established.
- Over HTTP, a user and password are sent as HTTP Basic on every call, which costs no extra round trip. `authMode: "token"` signs in once instead, caches the token until it nears expiry, and shares one in-flight sign-in between concurrent calls. A call that fails authentication in token mode is retried once with a fresh sign-in.
- Over a WebSocket the client signs in when the connection opens and again before the access token expires.
- `reconnect` takes `enabled`, `attempts`, `retryDelay`, `retryDelayMax`, `retryDelayMultiplier` and `retryDelayJitter`, with exponential backoff and jitter.
- `settings` become `SET name = 'value'` statements. Over a WebSocket they run once per connection, and a failing setting fails the first call. Over HTTP they are prepended to every call and their results are removed from the reply, because the instance keeps settings for the request only over HTTP.
- `timeout` and a caller `signal` combine into one abort. Over a WebSocket an abort sends `query_cancel` for that request; over HTTP it aborts the request.
- `MySQL USE db` switches the session database inside the session namespace through the instance's tenant check.

## mysql2 compatibility

```ts
import { createPool, createConnection } from "@surrealdb/mysql";

const pool = createPool({ uri: "mysql://root:root@abc123.surrealdb.earth/app?namespace=prod" });

const [rows, fields] = await pool.query("SELECT id, name FROM person WHERE name = ?", ["Tobie"]);
const [header] = await pool.execute("UPDATE person SET age = ? WHERE id = ?", [31, "tobie"]);
console.log(header.affectedRows, header.insertId);

const connection = await pool.getConnection();
try {
    await connection.beginTransaction();
    await connection.query("UPDATE account SET balance = balance - ? WHERE id = ?", [10, "x"]);
    await connection.commit();
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    connection.release();
}
await pool.end();
```

- **Result tuples.** Every promise method resolves `[rows, fields]`. A statement without rows resolves a `ResultSetHeader` (`fieldCount`, `affectedRows`, `insertId`, `info`, `serverStatus`, `warningStatus`, `changedRows`) and `undefined` fields. `insertId` is a number. A text with several statements resolves arrays of results and fields.
- **`query` and `execute`.** Both exist and both bind server-side, so there is no client-side interpolation. For `query` only, mysql2's conveniences are kept: an array value expands to a list (`WHERE id IN (?)`), an array of arrays expands to a list of lists (`VALUES ?`), and `??` quotes an identifier. These are exported as `prepare` and `escapeId`.
- **Options per call.** A first argument of `{ sql, values, rowsAsArray, typeCast, dateStrings, timeout }` is accepted.
- **`typeCast(field, next)`.** `field` has `type` (the type name such as `DATETIME`), `name`, `table`, `string()`, `buffer()` and `geometry()`, and `next()` returns the default decoding. `typeCast: false` returns text. Drizzle uses it to read `DATE`, `DATETIME` and `TIMESTAMP` as strings.
- **Fields.** Each field has `name`, `table`, `orgName`, `orgTable`, `characterSet`, `columnLength`, `columnType`, `type`, `flags` (`NOT_NULL` is set when the column is not nullable) and `decimals`.
- **Connection.** `query`, `execute`, `beginTransaction`, `commit`, `rollback`, `ping`, `end`, `destroy`, `connect`, `threadId`, and the events `connect`, `end` and `error`. A connection is one WebSocket session unless the configuration pins HTTP.
- **Pool.** `getConnection`, `releaseConnection`, `query`, `execute`, `end`, and the events `acquire`, `connection`, `release` and `enqueue`. `connectionLimit` defaults to 10. Pool `query` and `execute` run over stateless HTTP when the transport is `auto`; connections from `getConnection()` are WebSocket sessions. `release()` rolls back an open transaction before a connection is reused.
- **Config.** `uri`, `host`, `port`, `user`, `password`, `database`, `ssl`, `connectionLimit`, `bigNumberStrings`, `dateStrings`, `decimalNumbers`, `typeCast`, plus any option from [Connection](#connection). `supportBigNumbers`, `waitForConnections` and `multipleStatements` are accepted and have no effect: `BIGINT` is exact beyond the safe range by default, and a text may always hold several statements. With `host` and `port` and no `ssl` the client uses `http`; with `ssl` it uses `https`.

## PlanetScale drop-in

`@surrealdb/mysql/planetscale` has the surface of `@planetscale/database`, so code written for PlanetScale moves over by changing the import:

```diff
- import { Client, connect, cast, format } from "@planetscale/database";
+ import { Client, connect, cast, format } from "@surrealdb/mysql/planetscale";
```

```ts
import { Client } from "@surrealdb/mysql/planetscale";

const client = new Client({ url: "mysql://root:root@abc123.surrealdb.earth/app?ns=prod" });

const r = await client.execute("SELECT * FROM person WHERE name = ? AND age > :age", ["Tobie"]);
const named = await client.execute("SELECT * FROM person WHERE age > :age", { age: 18 });
const rows = await client.execute("SELECT id, name FROM person", [], { as: "array" });

await client.transaction(async (tx) => {
    await tx.execute("UPDATE account SET balance = balance - ? WHERE id = ?", [10, 1]);
    await tx.execute("UPDATE account SET balance = balance + ? WHERE id = ?", [10, 2]);
});
```

- Exports: `Client`, `connect`, `Connection`, `cast`, `format`, `DatabaseError`, `UnsupportedOnTransportError`, and the types `Config`, `ExecutedQuery`, `ExecuteOptions`, `Field`, `Cast`, `Transaction`, `Row`.
- `Config` takes `url` or `host`, `username` and `password`, plus `fetch`, `format` and `cast` as in the PlanetScale driver. It also takes `namespace`, `database`, `transport`, `WebSocket`, `headers` and `timeout`. The connection string follows the rules in [Connection](#connection): PlanetScale has no namespaces, so the SurrealDB namespace comes from the `ns` parameter of the URL or the `namespace` option, and the path is the database.
- `execute(query, args, options)` takes `?` placeholders with an array and `:name` placeholders with an object. Arguments are bound as parameters on the instance, not interpolated, so `statement` in the result is the query text with `?` markers. An array argument expands to a list, an empty one to `NULL`, and an object to JSON text. The `format` option of `Config` switches to client-side rendering, and the `format(query, values)` function is exported for that use.
- `as: "object"` (default) or `"array"` selects the row shape. Every value reaches `cast` as text, as on PlanetScale, and the default `cast` returns numbers for integer and float types up to 32 bits, parses JSON, and leaves 64-bit integers, decimals and dates as text. A per-call `cast` replaces the one in `Config`.
- `ExecutedQuery` has `headers`, `types` (Vitess type names such as `INT32` and `VARCHAR`, derived from the protocol type), `fields`, `rows`, `rowsAffected` (0 for a query which returns rows), `insertId` as text (`"0"` when there is none), `size`, `statement` and `time` in seconds. Fields carry no column length, character set or flags; those are zero or null.
- Failures throw `DatabaseError` with `body.message`, `body.code` (a Vitess-style code derived from the MySQL error number, `UNKNOWN` when there is none), `status` 400, and also `errno` and `sqlState`.
- `transaction(fn)` runs on a WebSocket session opened for the call, and commits when `fn` resolves or rolls back when it throws. PlanetScale offers this over HTTP; here HTTP is stateless, so a client configured with `transport: "http"` throws `UnsupportedOnTransportError`.
- `refresh()` resolves without a request, since HTTP calls keep no session.

To use Drizzle's `planetscale-serverless` driver, which checks `instanceof Client` against `@planetscale/database`, point that name at this entry point in your bundler instead of installing PlanetScale's package:

```ts
// vite.config.ts, or the equivalent alias of esbuild, webpack, tsconfig paths, wrangler.toml [alias]
resolve: { alias: { "@planetscale/database": "@surrealdb/mysql/planetscale" } }
```

```ts
import { drizzle } from "drizzle-orm/planetscale-serverless";
import { Client } from "@surrealdb/mysql/planetscale";

const db = drizzle(new Client({ url: process.env.DATABASE_URL }));
```

Drizzle transactions and savepoints run on the WebSocket session.

## Drizzle and Kysely

Drizzle:

```ts
import { createPool } from "@surrealdb/mysql";
import { drizzle } from "drizzle-orm/mysql2";

const pool = createPool({ uri });
const db = drizzle(pool as never, { mode: "default" });
```

Drizzle's select path uses `query` with `rowsAsArray` and `typeCast`, raw `all()` and the migrator use `execute`, and transactions pin one connection from `getConnection()`. These are all supported.

Kysely's `MysqlDialect` uses the callback API:

```ts
import { createPool } from "@surrealdb/mysql/callback";
import { Kysely, MysqlDialect } from "kysely";

const db = new Kysely({ dialect: new MysqlDialect({ pool: createPool({ uri }) as never }) });
```

The callback pool has `getConnection(cb)`, `query(sql, values?, cb)`, `execute`, `end(cb)`, `on` and `promise()`. Its connections have `query`, `execute`, `connect`, `beginTransaction`, `commit`, `rollback`, `ping`, `end`, `release`, `destroy`, `threadId`, `config` and `promise()`. Kysely detects a write by `insertId` and `affectedRows` on the result, and both are set.

The adapters' types name `mysql2`'s classes, so pass the pool with `as never`.

## Runtimes

The package uses `fetch`, `WebSocket`, `AbortController` and `TextEncoder`, and no Node built-ins. It runs on Node 20 and later, Bun, Deno, Cloudflare Workers, Vercel Edge and browsers. Node versions without a global `WebSocket` need a constructor passed as the `WebSocket` option; HTTP alone needs nothing extra. The native entry is about 10 kB minified and brotlied.

Do not put database credentials in browser code that real users can read. Use a token, or a function that returns one.

## Exports

- Native: `connect`, `decodeMysql`, `TYPE_NAMES`, `settingStatements`, and the types `SqlClient`, `Queryable`, `Result`, `Column`, `QueryOptions`, `BatchOptions`, `TransactionOptions`, `LiveMessage`, `Capabilities`, `MysqlConnectOptions`, `MysqlDecodeOptions`.
- mysql2 layer: `createPool`, `createConnection`, `Pool`, `Connection`, `MysqlError`, `prepare`, `escapeId`, `toConnectOptions`, and the types `ConnectionConfig`, `PoolConnection`, `QueryConfig`, `QueryReply`, `ResultSetHeader`, `FieldPacket`, `TypeCast`, `TypeCastField`.
- `@surrealdb/mysql/callback`: `createPool`, `createConnection`, `CallbackPool`, `CallbackConnection`.
- `@surrealdb/mysql/planetscale`: see [PlanetScale drop-in](#planetscale-drop-in).
- Errors: `SurrealSqlError`, `StatementError`, `CapabilityDeniedError`, `AuthError`, `RpcError`, `ConnectionError`, `ConnectionLostError`, `AbortError`, `TimeoutError`, `UnknownResponseError`, `UnsupportedOnTransportError`.

## Limits

- Not provided in the mysql2 layer: streaming (`.stream()`), `LOAD DATA LOCAL`, `COM_CHANGE_USER`, SSL options (TLS follows the URL scheme), named placeholders, and `nestTables`.
- Prisma's MySQL driver adapters have not been assessed. `@prisma/adapter-planetscale` and Kysely's PlanetScale dialect construct the vendor's own classes and are not supported. Drizzle `planetscale-serverless` works through the [PlanetScale drop-in](#planetscale-drop-in).
- Not built yet: CBOR transport and a browser warning for credentials.
- The native MySQL value encoding and the shapes of `query_cancel` and `describe` replies are provisional until the instance documents them.

## Licence

Apache-2.0.
