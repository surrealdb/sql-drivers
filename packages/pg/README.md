# @surrealdb/pg

A PostgreSQL-dialect client for SurrealDB that runs where TCP is not available: Cloudflare Workers, Vercel Edge, browsers, Deno, Bun and Node 20 and later. It sends PostgreSQL text to an instance over the `pgsql` RPC method, on HTTP for one-shot work and on a WebSocket for sessions.

It has two layers. The native API is a tagged template and `query`, `batch` and `begin` helpers. The compatibility layer is a node-postgres style `Client` and `Pool`, which lets Drizzle, Kysely and Prisma run on top of it.

For native drivers over TCP (`pg`, and others), use the PostgreSQL wire listener of the instance instead.

Status: the instance side of the `pgsql` method is in development. Until a server build ships it, the packages are verified against a contract simulator (see `docs/COMPATIBILITY.md` at the repository root).

## Install

```bash
npm install @surrealdb/pg
```

## Native API

```ts
import { connect } from "@surrealdb/pg";

const sql = connect("postgres://root:root@abc123.surrealdb.earth/app?namespace=prod");

// Tagged template: values become bound parameters, rows come back
const rows = await sql`SELECT name, age FROM person WHERE name = ${name} AND age > ${18}`;

// Full result: columns, command tag and row count
const result = await sql.query("UPDATE person SET age = $1 WHERE id = $2", [31, "tobie"]);
console.log(result.command, result.rowCount);

// Nested templates and trusted raw text share one placeholder counter
const adults = sql`age > ${18}`;
await sql`SELECT * FROM person WHERE ${adults} ORDER BY ${sql.raw("name")}`;
```

Calling `sql("...", [...])` as a plain function throws, so a misused call never sends unbound placeholders.

### Batch and transactions

```ts
// One HTTP request; all statements commit or none do
const [a, b] = await sql.batch([
    sql`INSERT INTO person (id, name) VALUES (${"a"}, ${"A"})`,
    sql`SELECT count(*) FROM person`,
]);

// Interactive transaction, on a dedicated WebSocket session
await sql.begin(
    async (tx) => {
        await tx`UPDATE account SET balance = balance - ${10} WHERE id = ${"x"}`;
        await tx`UPDATE account SET balance = balance + ${10} WHERE id = ${"y"}`;
    },
    { isolation: "serializable" },
);
```

HTTP holds no transaction between requests, so interactive transactions, live queries and settings that last for the session need the WebSocket. With `transport: "http"` pinned, `begin` and `live` throw `UnsupportedOnTransportError`. With the default `transport: "auto"`, one-shot calls use HTTP and `begin` opens a WebSocket for the length of the transaction.

### SurrealDB extras

```ts
// SurrealQL on the same connection, namespace, database and auth
const [people] = await sql.surql`SELECT * FROM person WHERE age > ${18}`;

// Live queries over a WebSocket
for await (const message of sql.live("person")) {
    console.log(message.action, message.result);
}

// Column and parameter metadata without running the statement
const { columns, params } = await sql.describe("SELECT name FROM person WHERE name = $1");

// What the instance allows
console.log(await sql.capabilities());
```

### Values

Values decode by the wire type of their column: `int8` is a number inside the safe range and a `bigint` outside it, `numeric` stays an exact string, `timestamp`, `timestamptz` and `date` are `Date`, `bytea` is `Uint8Array`, `json` is parsed, record ids are `RecordId` objects, vectors are `Float32Array`. Override with `parse: { timestamptz: (raw) => raw }` or a catch-all `cast(column, value)`, per client or per call.

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
    WebSocket, // injectable; needed on Node versions without a global WebSocket
});
```

Connection strings: `surrealdb://user:pass@host/<namespace>/<database>` (with `+http`, `+https`, `+ws`, `+wss` suffixes to pin a scheme), or an existing `postgres://user:pass@host/<database>?namespace=<namespace>`. Hosts other than loopback use TLS by default.

With user and password credentials, HTTP calls send HTTP Basic on every request, which costs no extra round trip; `authMode: "token"` signs in once instead. Session `settings` are sent once per connection over a WebSocket and with every call over HTTP, where the instance keeps them for the request only.

## node-postgres compatibility

```ts
import { Pool } from "@surrealdb/pg";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({
    connectionString: "postgres://root:root@abc123.surrealdb.earth/app?namespace=prod",
});
const db = drizzle({ client: pool as never });
```

`Client` and `Pool` follow the node-postgres surface that the adapters use: `query(text | config, values?)` with `rowMode` and `types`, `connect`, `release`, `end`, events, `types`, `DatabaseError`-shaped errors. Values travel in the dialect's text form and go through `types.getTypeParser`, so Drizzle's parser overrides apply.

Prisma needs a real `pg.Pool` instance. Give `pg` our client:

```ts
import pg from "pg";
import { Client } from "@surrealdb/pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString, Client });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
```

`pg` is an optional peer dependency used only for that. Drizzle's node-postgres driver imports `pg` itself, so Drizzle and Prisma users install `pg` regardless.

The TypeScript types of the adapters name `pg`'s classes, so pass `pool as never` (or cast to `pg.Pool`) where they ask for one.

Not provided: cursors, `COPY`, binary format, `LISTEN` and `NOTIFY` (use `sql.live()`), `pg-native`. Kysely streaming is therefore unavailable.

## Licence

Apache-2.0.
