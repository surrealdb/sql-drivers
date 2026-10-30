# Compatibility matrix

"Simulator" means the real adapter code runs against a contract simulator in `test-support/`: PGlite (a real PostgreSQL) for `@surrealdb/pg` and SQLite for `@surrealdb/mysql`, both behind the `pgsql` and `mysql` RPC shapes of the engine's client contract. It verifies call forms, result shapes, `instanceof` checks, type parsers and transaction handling. It does not verify engine behaviour: SQL dialect coverage, value encodings, SQLSTATE mapping or OIDs. "Server" means the integration suite against a built `surreal` binary.

| Adapter                                                                                                                                                      | Version read | Simulator                                                                              | Server (engine branch)                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| drizzle-orm `node-postgres` (Pool and Client: CRUD, timestamps, bigint, transactions with savepoints, migrator)                                              | 0.45.4       | passing                                                                                | passing, including `RETURNING` and `jsonb` parameters                                       |
| kysely `PostgresDialect` (DDL, returning, affected rows from `command`, transactions with isolation, raw sql)                                                | 0.29.7       | passing                                                                                | passing, including isolation levels sent as statement text                                  |
| real `pg.Pool` with `{ Client }` (instanceof, `types`, `rowMode`, pinned transactions, error fields)                                                         | pg 8.23.1    | passing                                                                                | passing                                                                                     |
| `@prisma/adapter-pg` over `pg.Pool({ Client })` (nested create, relation joins, P2002, interactive and batch transactions)                                   | 7.10.1       | passing                                                                                | passing (nested create, relation joins, P2002, interactive and batch transactions)          |
| drizzle-orm `mysql2` (CRUD, `typeCast` for datetime, `execute`, transactions, error shape)                                                                   | 0.45.4       | passing (SQLite syntax)                                                                | passing (insert, select, update, delete, transactions)                                      |
| kysely `MysqlDialect` over the callback pool                                                                                                                 | 0.29.7       | passing (SQLite syntax)                                                                | passing (insert, select, update, affected rows)                                             |
| drizzle `neon-http` over `neon()` from `@surrealdb/pg/neon` (CRUD, returning, `db.batch` as one atomic call, `$withAuth`, refused interactive transactions)  | 0.45.4       | passing (the driver's `@neondatabase/serverless` import is aliased to the entry point) | not run (the `neon()` function itself passes)                                               |
| drizzle `neon-serverless` over `Pool` from `@surrealdb/pg/neon` (`neonConfig.webSocketConstructor`, CRUD, interactive transactions)                          | 0.45.4       | passing (aliased)                                                                      | not run                                                                                     |
| drizzle `planetscale-serverless` over `Client` from `@surrealdb/mysql/planetscale` (`instanceof` check, CRUD, transactions with savepoints, `DatabaseError`) | 0.45.4       | passing (SQLite syntax, aliased)                                                       | not run                                                                                     |
| `@neondatabase/serverless` API surface (`neon` call forms, `fullResults`, `arrayMode`, `authToken`, `fetchOptions`, `neonConfig`)                            |              | unit tests and the PGlite simulator; the vendor package itself is not installed or run | tagged template, `transaction` with `Serializable` and `readOnly`, `NeonDbError` codes pass |
| `@planetscale/database` API surface (`execute` with `?` and `:name`, `as`, `cast`, `format`, `ExecutedQuery`, `DatabaseError`)                               |              | unit tests and the SQLite simulator; the vendor package itself is not installed or run | `execute` with `?` and `:name` and `DatabaseError` pass                                     |
| `@prisma/adapter-neon`, `@prisma/adapter-planetscale`, kysely-planetscale                                                                                    |              | not supported: they construct the vendors' own classes                                 |                                                                                             |
| Prisma MySQL driver adapters                                                                                                                                 |              | not assessed                                                                           |                                                                                             |

The Neon and PlanetScale rows alias the vendor package names to the entry points in the vitest configuration (`vendorAlias`), because Drizzle's drivers import those packages by name. Applications do the same in their bundler.

Where the Neon and PlanetScale options cannot be carried by the engine contract, the entry points refuse or ignore them as follows:

- `transaction()` sends `isolationLevel` and `readOnly` as the `isolation` and `readOnly` options of the atomic call. `ReadUncommitted`, `ReadCommitted` and `RepeatableRead` run as `snapshot`. `deferrable` is ignored.
- `neonConfig` fields which describe Neon's wire protocol (`wsProxy`, `useSecureWebSocket`, `pipelineConnect`, `pipelineTLS`, `coalesceWrites`, `forceDisablePgSSL`, `disableSNI`, `fetchConnectionCache`, `poolQueryViaFetch`, `subtls`, `rootCerts`) are accepted and ignored.
- PlanetScale `transaction(fn)` needs a WebSocket session; with `transport: "http"` it throws `UnsupportedOnTransportError`. `Field` entries carry no column length, character set or flags.
- Neither entry point is verified against the vendor's own package or a real server; the assumption that the engine answers the `pgsql` and `mysql` calls with `valueMode: "text"` and per-entry `vars` in atomic calls follows the contract and the existing integration suites for `batch`.

"Server" is the integration suite run against a debug build of the engine branch that makes the `pgsql` and `mysql` methods drop-in compatible (tracking issue #2407 in the engine repository), with `storage-mem,http,scripting,postgres,mysql`. Against the first engine to serve the methods, six behaviours blocked or worked around parts of this table; each is fixed on that branch and the client carries no workaround for any of them:

1. `RETURNING` answers its columns in the order the statement names them, so Drizzle and Prisma read the rows correctly.
2. `valueMode: "text"` gives plain decimal text, with no `30i32` suffix.
3. `BEGIN ISOLATION LEVEL ...`, `START TRANSACTION READ ONLY`, `WITH CONSISTENT SNAPSHOT` and `SET TRANSACTION` open or configure a real transaction. The node-postgres and mysql2 layers send the text as written. `READ UNCOMMITTED`, `READ COMMITTED` and `REPEATABLE READ` run as `snapshot`, which the SQL standard allows.
4. Text parameters are read as the type of the column they are written to, compared with an integer key, written to a link column, or used as `LIMIT` and `OFFSET`. This needs the column to be declared (`DEFINE FIELD ... TYPE`), and does not apply in a request that also holds DDL.
5. Errors carry the SQLSTATE and MySQL error number a client branches on (`42P01`, `23505`, `23502`, `22P02`, `40001`, `1146`, `1062` and so on).
6. Atomic calls take `isolation` and `readOnly`, and an uncommitted atomic call marks the entries that ran as `rolled_back` (`rolledBack` on a result).

JSON cannot carry an integer beyond 2^53 exactly. The node-postgres layer reads in text mode, so an `int8` is exact; the native API with the JSON transport is not.

The native APIs and the transports are covered by unit tests with a fake `fetch` and a fake `WebSocket`; the integration suite repeats them against a server.

## Running

```bash
bun install
bun run build           # also needed for the built-output tests
bun run test            # unit
bun run test:compat     # generates the Prisma client, then runs the adapter suites
SURREAL_BIN=/path/to/surreal bun run test:integration
```
