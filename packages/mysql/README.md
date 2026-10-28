# @surrealdb/mysql

A MySQL-dialect client for SurrealDB that runs where TCP is not available: Cloudflare Workers, Vercel Edge, browsers, Deno, Bun and Node 20 and later. It sends MySQL text to an instance over the `mysql` RPC method, on HTTP for one-shot work and on a WebSocket for sessions.

It has two layers. The native API is a tagged template and `query`, `batch` and `begin` helpers. The compatibility layer is a `mysql2/promise` style `createPool` and `createConnection`, plus a callback pool, which lets Drizzle and Kysely run on top of it.

For native drivers over TCP (`mysql2`, and others), use the MySQL wire listener of the instance instead.

Status: the instance side of the `mysql` method is in development. Until a server build ships it, the packages are verified against a contract simulator (see `docs/COMPATIBILITY.md` at the repository root).

## Install

```bash
npm install @surrealdb/mysql
```

## Native API

```ts
import { connect } from "@surrealdb/mysql";

const sql = connect("mysql://root:root@abc123.surrealdb.earth/app?namespace=prod");

const rows = await sql`SELECT name, age FROM person WHERE name = ${name} AND age > ${18}`;

const result = await sql.query("UPDATE person SET age = ? WHERE id = ?", [31, "tobie"]);
console.log(result.command, result.rowCount, result.insertId);

// One HTTP request; all statements commit or none do
await sql.batch([
    sql`INSERT INTO person (id, name) VALUES (${"a"}, ${"A"})`,
    sql`SELECT count(*) FROM person`,
]);

// Interactive transaction, on a dedicated WebSocket session
await sql.begin(async (tx) => {
    await tx`UPDATE account SET balance = balance - ${10} WHERE id = ${"x"}`;
    await tx`UPDATE account SET balance = balance + ${10} WHERE id = ${"y"}`;
});
```

Parameters always bind as typed parameters; nothing is interpolated into the text. Calling `sql("...", [...])` as a plain function throws.

HTTP holds no transaction between requests, so interactive transactions and live queries need the WebSocket. With `transport: "http"` pinned, `begin` and `live` throw `UnsupportedOnTransportError`.

SurrealDB extras work as in `@surrealdb/pg`: `sql.surql`, `sql.live`, `sql.describe`, `sql.capabilities`, `sql.withDatabase`.

Value decoding by protocol type is provisional until the instance documents its MySQL value encoding: integers are numbers (`BIGINT` is a string beyond the safe range), `DECIMAL` is an exact string, date types are `Date` unless `dateStrings`, `JSON` is parsed.

## Connection

```ts
connect({
    url: "surrealdb+wss://abc123.surrealdb.earth/prod/app",
    auth: { username: "root", password: "..." },
    transport: "auto",
    timeout: 15_000,
    settings: { time_zone: "+00:00" },
});
```

Connection strings: `surrealdb://user:pass@host/<namespace>/<database>`, or `mysql://user:pass@host/<database>?namespace=<namespace>`. Hosts other than loopback use TLS by default.

## mysql2 compatibility

```ts
import { createPool } from "@surrealdb/mysql";
import { drizzle } from "drizzle-orm/mysql2";

const pool = createPool({ uri: "mysql://root:root@abc123.surrealdb.earth/app?namespace=prod" });
const db = drizzle(pool as never, { mode: "default" });
```

Every promise method resolves `[rows, fields]`; writes resolve a `ResultSetHeader` with `affectedRows` and `insertId`. `query` and `execute` both exist and both bind server-side. `rowsAsArray`, `typeCast(field, next)` and `getConnection()` with `release()` are supported, and `?` accepts mysql2's array expansion and `??` identifiers for `query`.

Kysely's `MysqlDialect` uses the callback API:

```ts
import { createPool } from "@surrealdb/mysql/callback";
import { Kysely, MysqlDialect } from "kysely";

const db = new Kysely({ dialect: new MysqlDialect({ pool: createPool({ uri }) as never }) });
```

Not provided: streaming, `LOAD DATA LOCAL`, SSL options (TLS follows the URL scheme), Prisma's MySQL adapters (not yet assessed).

## Licence

Apache-2.0.
