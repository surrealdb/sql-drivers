# Design: @surrealdb/pg and @surrealdb/mysql

Status: draft 1, written against the RPC contract in surrealdb-private PR 2369 ("Client contract" in `doc/design/sql-dialect-rpc-methods.md`, commit b57b4a5884). The engine side has not landed yet, so every engine behaviour below is the contract's promise, not an observed fact, until the integration suite in this repo has run against a built binary.

## 1. Goals and non-goals

Goals:

- Two small TypeScript packages that talk PostgreSQL text or MySQL text to a SurrealDB instance over the `pgsql` and `mysql` RPC methods, on runtimes without TCP: Cloudflare Workers, Vercel Edge, browsers, Deno, Bun and Node 20+.
- A native API that is pleasant on its own, plus a compatibility layer that lets existing ORMs and query builders run on top of it.
- SurrealDB-only extras that a Postgres or MySQL serverless driver cannot offer: live queries, SurrealQL on the same connection, CBOR, capability awareness, namespace and database selection.

Non-goals:

- Not forks. No code is copied from `@neondatabase/serverless` (MIT, Neon Inc.) or `@planetscale/database` (Apache-2.0, PlanetScale). Both were read for their documented behaviour and public API shapes only; every borrowed idea is credited in section 12.
- No TCP wire client. Native drivers (`pg`, `mysql2`) already talk to the PostgreSQL and MySQL wire listeners that Earth exposes over TCP. These packages are for places where TCP is unavailable.
- No emulation of the Neon or PlanetScale vendor protocols. Several adapters hard-code `instanceof` checks against those vendors' classes (section 8), so supporting them would mean the engine speaking those protocols. That is a separate track.

## 2. What the transport gives us

From the contract, the facts the design depends on:

- Methods `pgsql` and `mysql` take `[statements, vars?, options?]`. `statements` is a string, or an array of strings and `{text, vars}` objects (a batch). `vars` holds only `_1` to `_n` keys, bound as typed parameters through the extended protocol, never substituted into text.
- Options: `describe`, `rowMode` (`object` or `array`), `valueMode` (`native` or `text`), `atomic`.
- The response is `{statements[], params?, transaction{status,id?}}`. Each statement result has `status`, `time`, `command{tag,rows_affected,last_insert_id,warnings}`, `columns[]`, `rows[]`, and on failure `error{message,severity,sqlstate,errno,position}`.
- Statement errors are inside the statement entry and the call succeeds. Non-statement errors (`NotAllowed`, `invalid_params`, unknown session, deadline) fail the call as RPC errors.
- Transactions are WebSocket-only. A dialect `BEGIN` opens one on the session, `transaction.status` reports `idle`, `active` or `failed`. Over HTTP the status is always `idle`, `BEGIN` is refused, and atomic work uses a batch with `atomic: true`.
- Settings (`SET ...`) last for the session over WebSocket and only for the request over HTTP, so over HTTP every call that needs a setting carries its `SET` statements in the same batch.
- `search_path` is a stored setting. It never switches namespace or database; `use` does.
- `query_cancel` addressed by request id cancels a running call over WebSocket; over HTTP, aborting the request cancels.
- `valueMode: "text"` returns every value in the dialect's text-protocol form, which is what lets the node-postgres layer reuse node-postgres-style parsers and stay faithful.
- Live queries, variables, permissions and limits behave as for `query` on the same session.

Consequence: HTTP is one-shot plus atomic batch only. Interactive transactions, live queries and session settings that persist are WebSocket-only. The design never offers an interactive transaction over HTTP; a pinned `http` transport throws `UnsupportedOnTransportError` for `begin`. If the engine later adds a server-side transaction store, the transport interface already has a place for it (section 4.2).

## 3. Package layout

```
sql-drivers/
  packages/
    internal/   @surrealdb/sql-internal  (private, never published, bundled into the others)
    pg/         @surrealdb/pg
    mysql/      @surrealdb/mysql
  docs/DESIGN.md
  .github/workflows/
```

`@surrealdb/sql-internal` holds everything dialect-neutral: connection string parsing, config resolution, the `Transport` interface with its HTTP and WebSocket implementations, JSON and CBOR codecs, the auth manager (signin, token expiry and refresh), the reconnect policy, request abort and timeout handling, the session and transaction state machine, the error hierarchy, the lazy statement object, the `surql` passthrough and the live query dispatcher. It exposes no dialect value types.

`@surrealdb/pg` and `@surrealdb/mysql` hold the dialect specifics: the SQL template builder (`$1` versus `?`), value decoding by wire type, the native API surface, and the compatibility layer.

The internal package is bundled into each public package at build time (tsup with `noExternal`), so a user installs one package with no sibling dependency to version-match. Shared code is duplicated in the two bundles, which is acceptable because a project uses one dialect in practice. Size budgets are in section 11.

## 4. Internal core

### 4.1 Config resolution

One resolver turns a connection string and an options object into a `ResolvedConfig`:

```ts
interface ResolvedConfig {
    endpoint: URL; // http(s) base for HTTP, ws(s) base for WebSocket
    namespace?: string;
    database?: string;
    auth?: Credentials | TokenProvider; // user/pass, token, or function returning either
    transport: "auto" | "http" | "ws";
    codec: "json" | "cbor";
    timeoutMs?: number; // default per request
    reconnect: ReconnectOptions;
    fetch?: typeof fetch; // injectable, as for both reference drivers
    WebSocket?: WebSocketConstructor;
    headers?: Record<string, string>;
}
```

Connection strings, parsed the same way by both packages (formats in section 6):

- `surrealdb://[user[:pass]@]host[:port]/<namespace>/<database>[?options]` with `+https`, `+http`, `+wss`, `+ws` scheme suffixes to pin the scheme.
- Drop-in forms so an existing `DATABASE_URL` works: `postgres://` and `postgresql://` for `@surrealdb/pg`, `mysql://` for `@surrealdb/mysql`. The path is the SurrealDB database; the namespace comes from `?namespace=` (or `?ns=`). Port is ignored unless an explicit scheme suffix is given.
- Hosts ending in `.surrealdb.earth` and `.surreal.cloud` default to TLS (`https` and `wss`). `localhost`, `127.0.0.1` and `[::1]` default to plain.

### 4.2 Transport interface

Everything above the transport speaks this interface, so unit tests use a mock and the real transports are interchangeable:

```ts
interface Transport {
    readonly kind: "http" | "ws";
    readonly capabilities: {
        interactiveTransactions: boolean;
        live: boolean;
        persistentSettings: boolean;
    };
    call<T>(method: string, params: unknown[], opts?: CallOptions): Promise<T>; // one RPC call
    open(): Promise<void>;
    close(): Promise<void>;
    onEvent(handler: (event: TransportEvent) => void): () => void; // live notifications, disconnects
}
interface CallOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    txn?: string;
    requestId?: number;
}
```

- `HttpTransport`: `POST <endpoint>/rpc` with `Content-Type` and `Accept` for JSON or CBOR, `Surreal-NS` and `Surreal-DB` headers, `Authorization: Bearer <token>`. Stateless. One call per request. Cancellation is `AbortController`. `capabilities` are all false.
- `WsTransport`: one WebSocket to `<endpoint>/rpc`, offering the `json` or `cbor` subprotocol explicitly. Calls are multiplexed by `id`. Sends `use`, `signin` or `authenticate` on open, `query_cancel` on abort. Handles live notification frames (id-less messages) and routes them to the live dispatcher. `capabilities` are all true.
- Auto selection: `transport: "auto"` uses HTTP for `execute`, `query` and `batch` (lowest latency from a cold edge isolate, no handshake) and opens a WebSocket on first use of anything that needs a session (`begin`, `live`, a `Client` or `Pool` connection). A user can pin either.
- A future `HttpSessionTransport` (stored HTTP sessions with an engine-held transaction) would implement the same interface with `interactiveTransactions: true`. Not built now.

### 4.3 Auth

Borrowed from the shape of `surrealdb` (JS SDK) auth: credentials are an object (`{username, password, namespace?, database?}` for system users, `{access, variables}` for record access, or a raw token string). The resolver also accepts `auth: () => string | Promise<string>` for rotating tokens, an idea shared with the reference drivers' per-request `authToken` functions.

- Over WebSocket: `signin` once per connection, store the returned access token and refresh token if present, call `refresh` before expiry (decoded from the JWT `exp` claim, with 30 seconds of skew), re-`authenticate` after reconnect.
- Over HTTP: when credentials are a token, send `Authorization: Bearer <token>` on each call. When credentials are user and password the default is HTTP Basic on each call, which costs no extra round trip (the cold-start path this transport exists for); `auth.mode: "token"` instead signs in once, caches the token until near expiry and shares one in-flight sign-in between concurrent callers.
- A 401 or an `invalid auth` RPC error triggers exactly one forced re-sign-in and one retry of the call, never more, and never for a statement that may have partially run (writes in a failed transport are not retried blindly, see 4.5).

### 4.4 Sessions and transactions

The session state machine is internal: `idle`, `active`, `failed`, taken from `transaction.status` in each response, not guessed. Interactive transactions run on a dedicated WebSocket session (one WebSocket per `Client`, one per pooled connection). `begin(fn)` sends the dialect `BEGIN`, runs the callback, sends `COMMIT`, and on any throw sends `ROLLBACK` inside a try/catch so a failing rollback never masks the original error. `atomic: true` batches are the only transactional primitive over HTTP.

### 4.5 Reconnect and retry

WebSocket reconnect uses exponential backoff with jitter and the same option names as `surrealdb` (`enabled`, `attempts`, `retryDelay`, `retryDelayMax`, `retryDelayMultiplier`, `retryDelayJitter`). On reconnect the session is rebuilt (`use`, `authenticate`), and an open transaction is lost: the driver surfaces `ConnectionLostError` with `inTransaction: true` and does not replay statements. Idempotent reads over HTTP may be retried once on a network error before any response bytes; writes are never retried automatically.

### 4.6 Errors

```
SurrealSqlError (base)
  ConnectionError / ConnectionLostError
  AuthError
  CapabilityDeniedError        // NotAllowed naming the method or route capability
  RpcError                     // non-statement RPC failure, carries code and kind
  StatementError               // statement-level, carries sqlstate, errno, position, severity
  AbortError / TimeoutError
  UnsupportedOnTransportError  // begin or live requested on a pinned HTTP transport
  UnknownResponseError         // non-JSON or proxy reply, truncated body and headers kept
```

The last item borrows the idea of a distinct error for non-database replies from `@planetscale/database`. `StatementError` is what the compatibility layers convert to node-postgres `DatabaseError` (with `code`, `severity`, `detail`, `hint`, `position`, `message`) and mysql2-style errors (`code`, `errno`, `sqlState`, `sqlMessage`).

## 5. Public API, native

Both packages export the same shape. Dialect differences are noted inline.

```ts
import { connect } from "@surrealdb/pg"; // or "@surrealdb/mysql"

const sql = connect("postgres://root:root@abc123.surrealdb.earth/app?namespace=prod");

const rows = await sql`SELECT * FROM person WHERE name = ${name} AND age > ${age}`;
const res = await sql.query("SELECT * FROM person WHERE id = $1", [id], { rowMode: "array" });
const info = await sql.execute("UPDATE person SET age = $1 WHERE id = $2", [31, id]); // rowsAffected, command
```

### 5.1 Call forms (borrowed shape: Neon's `neon()`)

- Tagged template: `` sql`...${v}` `` returns a lazy thenable (`Statement`). Values become `$n` (pg) or `?` (mysql) placeholders and `_n` vars. Nesting a `Statement` or `sql.raw()` value inlines it, sharing one placeholder counter. `sql.raw(text)` splices trusted text verbatim and is the only way to put text into the statement.
- `sql.query(text, params?, opts?)` returns a `Result`. `sql.execute(text, params?, opts?)` is an alias that reads better for writes.
- Calling `sql("...", [...])` as a plain function throws a descriptive error, so a misused signature never sends unbound placeholders. This is the lesson of `@planetscale/database` 2.0.0, which rejects its removed call forms for the same reason.
- No client-side escaping or interpolation exists anywhere in the package. Parameters always travel as `vars`.

### 5.2 Results

By default a tagged template resolves to rows. `Result` is the full form, selected with `{fullResults: true}` or by using `query`:

```ts
interface Result<Row = Record<string, unknown>> {
    rows: Row[]; // objects, or arrays with rowMode "array"
    columns: Column[]; // name, type (dialect wire type), nullable, table, column
    command: string; // tag, for example "SELECT 3", "INSERT 0 1"; mysql: statement kind
    rowCount: number; // rows_affected
    insertId?: bigint | number | null; // mysql last_insert_id
    warnings?: number; // mysql
    time: string; // server time for the statement
    transaction: "idle" | "active" | "failed";
    results: Result[]; // every statement of the call, in order (this one is the last)
}
```

A text holding several statements always resolves to the `Result` of its last statement with `results: Result[]` listing every statement in order, so `rows` is what a caller usually wants and nothing is lost. `sql.batch` resolves to an array of `Result`, one per entry. An `error` in any statement entry throws `StatementError` (carrying the partial `results`), except in batch calls with `{throwOnError: false}`, where each entry reports `ok` and `error`.

### 5.3 Typed values

Decoding is driven by `columns[].type`, using the value table in the contract:

| Wire type (pg)                             | JS value, default                                              | Notes                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| bool                                       | boolean                                                        |                                                                                                                       |
| int2, int4, float4, float8                 | number                                                         |                                                                                                                       |
| int8                                       | number within safe range, else bigint                          | option `bigint: "always"                                                                                              | "never"          | "auto"` (default auto) |
| numeric                                    | string                                                         | exact decimal, never a lossy number; `decimal: "string"                                                               | "number"` option |
| text, varchar, char, name                  | string                                                         |                                                                                                                       |
| bytea                                      | Uint8Array                                                     | base64 on JSON, byte string on CBOR                                                                                   |
| uuid                                       | string                                                         |                                                                                                                       |
| date, time, timestamp, timestamptz, timetz | Date for timestamp, timestamptz, date; string for time, timetz | each overridable by a `parse` map keyed by type name                                                                  |
| interval                                   | string (ISO 8601 duration) plus helper `parseInterval()`       | an `Interval` object (months, days, nanoseconds) is exposed when the engine's new interval kind (ADR 0013) is present |
| json                                       | the parsed value                                               |                                                                                                                       |
| arrays                                     | arrays of the element decoding                                 |                                                                                                                       |
| record                                     | `RecordId` (table, key, `toString()` gives `table:key`)        | `recordIds: "string"` returns strings                                                                                 |
| vector                                     | `Float32Array`                                                 | option `vectors: "array"` returns number arrays                                                                       |
| enum                                       | string label                                                   | the type name carries the enum name once the engine reports it                                                        |

MySQL equivalents follow the `mysql_type` code: TINY/SHORT/LONG to number, LONGLONG to bigint when beyond the safe range, NEWDECIMAL to string, DATE/DATETIME/TIMESTAMP to Date unless `dateStrings`, JSON parsed, BLOB family to Uint8Array or string depending on the binary charset flag.

Per-client and per-call hooks: `parse: { [typeName]: (raw) => value }` and a catch-all `cast(column, value)`, a borrow of the per-field `cast` of `@planetscale/database` and the `types` option of Neon. Defaults keep integers and decimals lossless.

The same decoded types come out of HTTP and WebSocket, and out of JSON and CBOR. That equivalence is a test (section 11).

### 5.4 Batch and transaction helpers

```ts
// One HTTP request, atomic. Borrowed shape: neon's sql.transaction([...]).
const [a, b] = await sql.batch(
    [sql`INSERT INTO person (name) VALUES (${"a"})`, sql`SELECT count(*) FROM person`],
    { atomic: true },
);

// Interactive, WebSocket only. Borrowed shape: PlanetScale's transaction(fn).
const out = await sql.begin(
    async (tx) => {
        await tx`UPDATE account SET balance = balance - ${n} WHERE id = ${from}`;
        await tx`UPDATE account SET balance = balance + ${n} WHERE id = ${to}`;
        return tx`SELECT * FROM account WHERE id IN (${from}, ${to})`;
    },
    { isolation: "serializable", readOnly: false },
);
```

`batch` collects un-awaited lazy statements, sends them as one `[{text, vars}, ...]` call with `atomic`, and returns results in order. Calling `begin` while on a pure HTTP transport opens a WebSocket for the transaction's lifetime when `transport` is `auto`, and throws `CapabilityDeniedError`-style `UnsupportedOnTransportError` when pinned to `http`.

Options layering, documented and tested: per-call options beat batch or transaction options, which beat client options, which beat defaults. Fetch options are merged in that order, but the body, method, `Authorization` and content-type headers cannot be overridden by `fetchOptions`.

### 5.5 Record ids, vectors, intervals

- `RecordId` is a small class (`table`, `key`, `toString()`, `toJSON()`), with `recordId("person:tobie")` and `rid` tagged helper. Parameters accept `RecordId` instances and send the string form the engine expects.
- `sql.vector(Float32Array | number[])` binds a vector parameter for pgvector-style columns, and `<->`, `<=>`, `<#>` operators are plain SQL text.
- `interval` helpers: `parseInterval`, `formatInterval`, and a typed `Interval`.

## 6. Connection configuration

```ts
connect({
    url: "surrealdb+wss://abc123.surrealdb.earth/prod/app",
    auth: { username: "root", password: "..." }, // or { token } or () => token
    transport: "auto",
    codec: "json",
    timeout: 15_000,
    reconnect: { attempts: 5 },
    fetch,
    WebSocket, // injectable
    settings: { timezone: "UTC", application_name: "api" },
});
```

- SurrealDB Cloud and Earth: `https://<id>.surrealdb.earth` or the cloud host; the RPC path is `/rpc`. Namespace and database are part of the path in the connection string, or the `namespace` and `database` options.
- Self-hosted: `surrealdb+http://localhost:8000/test/test`, or `postgres://root:root@localhost:8000/test?namespace=test` for an existing URL.
- `settings` are sent as `SET` statements: once per connection over WebSocket, prepended to every call over HTTP because settings last for the request only there. The driver strips the results of the prepended statements before returning, so result indexes and `batch` destructuring never shift. A failing `SET` fails the whole call with a `StatementError` naming the setting; inside an `atomic` batch it aborts the batch before any user statement runs. They are `sql_`-prefixed engine side; the driver does not need to know.
- Timeouts: a client default and per-call `timeout`; both combine with a caller `signal` into one `AbortSignal` (`AbortSignal.any` where available, a small polyfill otherwise). Over WebSocket an abort sends `query_cancel` for that request id; over HTTP it aborts the fetch.
- Browser warning: like Neon's driver, a one-time console warning when a password or token appears in browser code, disabled with `disableWarningInBrowsers`.

## 7. SurrealDB-only extras

1. Live queries over WebSocket. The engine does not map LISTEN or NOTIFY, so there is no `LISTEN`-shaped emulation in v0. The native API offers `sql.live("person", { diff?: boolean })` returning an async iterable of `{action, id, result}`, implemented as SurrealQL `LIVE SELECT` through the same WebSocket (the `query` method), with kill on `return()`. The compatibility `Client` emits `notification` events only for channels a user explicitly bridges with `client.listenLive(channel, table)`, a documented non-standard helper. A true `LISTEN` mapping waits for an engine decision.
2. SurrealQL passthrough: `` sql.surql`SELECT * FROM person WHERE id = ${rid}` `` runs on the same connection, namespace, database and auth through the `query` method, with values encoded natively (record ids, datetimes, vectors) and the same lazy `Statement` semantics. Results decode by SurrealQL's own types, not the dialect's.
3. CBOR transport: `codec: "cbor"` uses `@surrealdb/cbor` for exact types (decimal tag, byte strings, datetimes) and smaller payloads. It is loaded from a separate entry (`@surrealdb/pg/cbor`) so the default bundle stays free of it. JSON is the default (see decision 1).
4. Capabilities awareness: `await sql.capabilities()` probes `version` plus an empty-statement `pgsql` call. A `NotAllowed` error is turned into `CapabilityDeniedError` naming the denied method or route (`--deny-http postgres`). Each package exposes `isSupported()` for startup checks, and the `Transport` flags drive which helpers are available.
5. Namespace and database selection: `sql.use({namespace, database})` on a session, `connect` options, and `sql.withDatabase("other")` returning a derived client that shares auth.
6. Server-side describe: `sql.describe(text)` returns column and parameter metadata without executing, from the contract's `describe` option. Useful for tooling and type generation.

## 8. Compatibility layer

### 8.1 Adapters, and what can be supported at all

From reading the adapter sources (drizzle-orm 0.45.4, @prisma/* 7.10.1, kysely 0.29.7, pg 8.23.1, mysql2 3.24.6):

| Adapter                                       | Supported    | How                                                                                                          | Verified by                                                                              |
| --------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| drizzle `node-postgres`                       | yes          | `@surrealdb/pg` `Client` or `Pool` passed as `client`                                                        | compat suite, drizzle queries, migrator, transactions                                    |
| drizzle `neon-http`                           | yes, stretch | `neon()`-shaped function from `@surrealdb/pg/neon-http` (`query`, `transaction`, `arrayMode`, `fullResults`) | compat suite (needs `@neondatabase/serverless` installed as drizzle imports its `types`) |
| drizzle `neon-serverless`                     | no           | hard `instanceof` on Neon's `Pool`                                                                           | none                                                                                     |
| drizzle `mysql2`                              | yes          | `@surrealdb/mysql` promise pool, `query` and `execute`                                                       | compat suite                                                                             |
| drizzle `planetscale-serverless`              | no           | hard `instanceof` on PlanetScale's `Client`                                                                  | none                                                                                     |
| `@prisma/adapter-pg`                          | yes          | `new pg.Pool({ Client })` from the real `pg` with our `Client`; needs real `pg` installed                    | compat suite, Prisma client queries and transactions                                     |
| `@prisma/adapter-neon`, `adapter-planetscale` | no           | construct vendor classes themselves                                                                          | none                                                                                     |
| Prisma MySQL driver adapter                   | later        | not yet read; candidate for a second pass                                                                    | none                                                                                     |
| kysely `PostgresDialect`                      | yes          | `@surrealdb/pg` `Pool`                                                                                       | compat suite                                                                             |
| kysely `MysqlDialect`                         | yes          | callback pool from `@surrealdb/mysql/callback`                                                               | compat suite                                                                             |
| node-postgres-typed code                      | yes          | `Client`, `Pool`, `types`, `DatabaseError` exports                                                           | unit tests against the surface                                                           |
| mysql2-typed code                             | partial      | `createPool`, `createConnection`, `query`, `execute`, `getConnection`, transactions                          | unit tests                                                                               |

"Verified" means the real adapter package code runs against a real SurrealDB server in the compat suite. Anything not yet run is marked as such in the package README.

### 8.2 `@surrealdb/pg` node-postgres surface

```ts
export class Client extends Emitter {
  constructor(config?: string | ClientConfig);
  connect(): Promise<void>; connect(cb: (err?: Error) => void): void;
  end(): Promise<void>; end(cb: () => void): void;
  query(text: string, values?: unknown[]): Promise<Result>;
  query(config: QueryConfig, values?: unknown[]): Promise<Result>;
  query(...args: [...unknown[], cb]): void;
  readonly processID: number;
}
export class Pool extends Emitter { /* connect, query, end, on/removeListener, totalCount, idleCount, waitingCount, options */ }
export const types: { getTypeParser, setTypeParser, builtins };
export class DatabaseError extends Error { severity; code; detail; hint; position; ... }
```

Behaviour:

- Every query sets `valueMode: "text"` and `rowMode: "array"` unless the caller asked for objects. Cells are passed through `config.types.getTypeParser(oid, "text")` when given, else the package's own parsers. This is what drizzle needs: it overrides parsers for timestamp, date and interval OIDs to return raw text, and a client that returned decoded values would break its mapping.
- `fields[].dataTypeID` comes from `columns[].type.oid`. Prisma's pg adapter throws on an unknown OID below 16384, so the engine must report only built-in PostgreSQL OIDs there; the compat suite checks the OIDs seen.
- `command` and `rowCount` come from `command.tag` and `command.rows_affected` (kysely needs `command` for affected-row counts).
- No Node built-ins anywhere in the packages: `Client` and `Pool` use a small emitter from the internal package (`on`, `addListener`, `once`, `off`, `removeListener`, `emit`, `listenerCount`, `removeAllListeners`) instead of `node:events`, and bytea decodes to `Uint8Array`, not `Buffer`. The bundle smoke test fails on any `node:` import.
- Class names survive the build (`keepNames` in tsup) because drizzle detects a pool by `constructor.name`; a built-output test asserts `Pool.name`.
- `Client` exposes what `pg-pool` touches: `connect(cb)`, `end(cb)`, `_queryable`, `_ending`, `connection`, `'error'` and `'end'` events. This lets `new pg.Pool({ Client })` work with the real `pg`, which is the only way to satisfy Prisma's `instanceof pg.Pool`. `pg` is an optional peer dependency, used only by that path, never imported by this package.
- `Pool` is our own class that does not need `pg`. Its constructor name contains "Pool" so drizzle's pool detection selects the transaction path that pins a connection.
- A `PoolClient` is one WebSocket session; `release()` rolls back an open transaction before returning it. Prisma's `commit` and `rollback` only call `release()` and the engine sends `COMMIT` as SQL, so the pinned session keeps the transaction open across calls, which the contract's session model supports.
- Errors become `DatabaseError` with `code` (SQLSTATE), `severity`, `message`, `position`. Socket-level failures keep Node-style `code` values where meaningful.
- Multi-statement simple queries resolve to `Result[]`, as node-postgres does.
- Not provided: `Cursor`, `COPY`, binary format, `LISTEN` (see section 7), `pg-native`. Kysely streaming therefore throws a clear error.

### 8.3 `@surrealdb/mysql` mysql2 surface

- `createPool(config)` and `createConnection(config)` return the promise API: `query`, `execute`, `beginTransaction`, `commit`, `rollback`, `end`, `ping`, `getConnection`, `release`, `destroy`, events, and `threadId`.
- Every promise method resolves `[rows, fields]`. DML resolves `[ResultSetHeader, undefined]` with `affectedRows`, `insertId` (a number, as drizzle requires, unless `supportBigNumbers`), `warningStatus`, `info`.
- `rowsAsArray: true` and `typeCast(field, next)` are honoured, with `field.type` as the type name string, `field.string()` and `field.buffer()`. Drizzle checks `field.type` against `TIMESTAMP`, `DATETIME` and `DATE` and asks for the string form.
- `execute` exists and behaves as `query` (server-side binding is native in this transport, since `vars` always bind as typed parameters). Drizzle's `all()` and migrator use it.
- `@surrealdb/mysql/callback` provides a callback pool (`getConnection(cb)`, `connection.query(sql, params, cb)`, `end(cb)`) because kysely's `MysqlDialect` uses the callback API and tests the OK-packet shape `insertId` plus `affectedRows`.
- Not provided: streaming (`.stream()`), `LOAD DATA LOCAL`, `COM_CHANGE_USER`, SSL options (TLS comes from the URL scheme).

## 9. Repository and tooling

Matched to surrealdb.js where it makes sense, with deviations listed.

| Concern         | surrealdb.js                                                                           | here                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Package manager | bun workspaces, `bun ci`                                                               | bun workspaces (same)                                                                                  |
| Lint and format | biome 2.x, 4-space indent, width 100                                                   | biome 2.6.3, same settings                                                                             |
| Tests           | `bun test`                                                                             | vitest (runs on Node, where the real `pg`, `mysql2`, drizzle, kysely and Prisma adapter code must run) |
| Build           | rolldown plus dts-bundle-generator, turbo                                              | tsup (esbuild plus dts), no turbo (two packages)                                                       |
| Licence         | Apache-2.0                                                                             | Apache-2.0                                                                                             |
| Changelog       | none in repo, no changesets; notes on GitHub releases (checked with `gh release list`) | same: GitHub releases, no CHANGELOG files                                                              |
| Publishing      | `scripts/publish.ts` per package, JSR dry run in CI                                    | same pattern later; JSR dry run in CI                                                                  |

CI (GitHub Actions, actions pinned by SHA like surrealdb.js): `check` (biome, tsc), `unit` (vitest), `build` (tsup plus size-limit), and a separate `integration` job that downloads or builds a `surreal` binary and runs the integration and compat suites.

## 10. Dependencies

- Runtime: none for the default JSON path. `@surrealdb/cbor` (allowed) only behind the `/cbor` entry.
- Optional peers: `pg` (only for the `new pg.Pool({ Client })` path), nothing for mysql.
- Dev: biome, typescript, tsup, vitest, size-limit with `@size-limit/file`, `@types/node`; for compat tests only: `pg`, `mysql2`, `drizzle-orm`, `kysely`, `@prisma/client` with `@prisma/adapter-pg` and the Prisma CLI, and `@neondatabase/serverless` for the stretch neon-http check. Prisma's CLI downloads schema engines, so that suite is opt-in and runs in the integration job only.

## 11. Test strategy

1. Unit (vitest, no network): the mock transport, scripted from the contract's JSON examples; template builder, option layering, decoders per wire type, error mapping, auth refresh and single retry, abort and timeout, reconnect policy with fake timers, transaction state machine, lazy statement and batch collection, connection string parsing (property tests for round trips).
2. Integration (real server): start `surreal` from a binary path given by `SURREAL_BIN` (searched in `target/` of the engine repo first), on a free port, storage `memory`, root credentials. Run the same native-API scenarios over HTTP and WebSocket, JSON and CBOR, and assert the decoded values are identical across all four. Includes atomic batch, interactive transaction rollback, `query_cancel`, live query, settings in batch, capability denial (`--deny-http postgres`), and token refresh with a short-lived access.
3. Compatibility (real adapters): drizzle (`node-postgres`, `mysql2`), kysely (both dialects), Prisma with `adapter-pg` over `pg.Pool({Client})`, and the `pg`/`mysql2` type surfaces. Each runs its own CRUD, migration and transaction path against the server. A matrix file in the repo records pass, fail and skipped per adapter and version; the README tables are generated from it.
4. Size: `size-limit` budgets for the native entry of each package (target under 12 kB gzipped for the JSON, fetch-only native path, with the compat layer as a separate subpath import and its own budget) and a bundle smoke test for Workers (workerd via `wrangler` or Miniflare-compatible esbuild target) and a browser target (esbuild with `platform: browser`) that fails if any `node:` import appears.

The integration binary is not built by this repo's CI by default; the job downloads a prebuilt artifact. Locally, `SURREAL_BIN` points to a binary built from the engine repo with `cargo build --locked --no-default-features --features storage-mem,http,scripting,postgres,mysql`; a binary built before the methods landed answers `Method not found`, and the integration suite fails fast with that message.

## 12. Credits for borrowed ideas

Ideas, not code:

- From `@neondatabase/serverless`: the node-postgres-compatible `Client` and `Pool` over a WebSocket transport; the `neon()` one-shot function with tagged-template, `query(text, params, opts)` and `transaction([...])` forms; lazy thenable queries that a transaction can collect; `arrayMode` and `fullResults`; per-call, per-transaction and per-client option layering; an injectable `fetch` and WebSocket constructor; `authToken` as a string or async function; the browser warning; and `neon()`-shaped client surface for drizzle's `neon-http`.
- From `@planetscale/database`: the `transaction(fn)` callback helper with automatic commit and rollback; a per-field `cast` hook with documented defaults and lossless 64-bit and decimal handling; the typed `ExecutedQuery` metadata idea (`time`, `size`); the distinct error type for non-database replies; and rejecting removed call forms loudly.
- From the `surrealdb` JS SDK: authentication shapes, token refresh, reconnect option names and backoff, the idea of a thin engine interface over HTTP and WebSocket.

## 13. Decisions needed from the user

1. Value codec dependency. Recommendation: JSON by default with zero runtime dependencies (the contract's value table makes JSON fully typed through `columns[].type`), CBOR optional through `@surrealdb/cbor` behind a separate entry. Do not depend on `@surrealdb/sqon` (which the current `surrealdb` SDK uses): it bundles text, flatbuffer and shaped codecs that cost edge bundle size. `@surrealdb/cbor` is published only as 2.0.0-alpha versions (`latest` is alpha.1, the SDK pins alpha.4); confirm which to pin.
2. Neon and PlanetScale adapters. Recommendation: do not chase drizzle `neon-serverless`, drizzle `planetscale-serverless` or Prisma's Neon and PlanetScale adapters, which hard-code vendor classes. Support drizzle `neon-http` through a `neon()`-shaped function as a stretch goal only.
3. LISTEN and NOTIFY. Recommendation: no emulation in v0; native `live()` only, plus the explicit `listenLive` bridge. An engine-side mapping is separate work.
4. Package manager. The brief allows pnpm or npm workspaces; surrealdb.js uses bun. Recommendation: bun workspaces, matching surrealdb.js (the lockfile is `bun.lock`).
5. `pg` as an optional peerDependency of `@surrealdb/pg`, used only by the `new pg.Pool({ Client })` path and never imported by the package. This is package metadata outside the allowed dependency set. Drizzle's node-postgres driver imports `pg` itself, so Drizzle and Prisma users must install `pg` regardless; the README says so.
6. Naming of the native entry point. Recommendation: `connect` (as `@planetscale/database` does), with `neon`-style call forms on the returned function.

Stated defaults, not open: HTTP is one-shot plus atomic batch and a pinned `http` transport throws on `begin`; changelog is GitHub releases only.
