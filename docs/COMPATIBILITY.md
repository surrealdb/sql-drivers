# Compatibility matrix

"Simulator" means the real adapter code runs against a contract simulator in `test-support/`: PGlite (a real PostgreSQL) for `@surrealdb/pg` and SQLite for `@surrealdb/mysql`, both behind the `pgsql` and `mysql` RPC shapes of the engine's client contract. It verifies call forms, result shapes, `instanceof` checks, type parsers and transaction handling. It does not verify engine behaviour: SQL dialect coverage, value encodings, SQLSTATE mapping or OIDs. "Server" means the integration suite against a built `surreal` binary.

| Adapter                                                                                                                                                      | Version read | Simulator                                                                              | Server (engine `b2b70df36f`)                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| drizzle-orm `node-postgres` (Pool and Client: CRUD, timestamps, bigint, transactions with savepoints, migrator)                                              | 0.45.4       | passing                                                                                | CRUD, typed selects and transactions pass; `RETURNING` and `jsonb` parameters fail on engine issues 1, 2 and 4 below |
| kysely `PostgresDialect` (DDL, returning, affected rows from `command`, transactions with isolation, raw sql)                                                | 0.29.7       | passing                                                                                | passing, including isolation levels through the RPC `begin` method                                                   |
| real `pg.Pool` with `{ Client }` (instanceof, `types`, `rowMode`, pinned transactions, error fields)                                                         | pg 8.23.1    | passing                                                                                | passing                                                                                                              |
| `@prisma/adapter-pg` over `pg.Pool({ Client })` (nested create, relation joins, P2002, interactive and batch transactions)                                   | 7.10.1       | passing                                                                                | not run: Prisma reads `RETURNING` rows by position, so engine issue 1 blocks it                                      |
| drizzle-orm `mysql2` (CRUD, `typeCast` for datetime, `execute`, transactions, error shape)                                                                   | 0.45.4       | passing (SQLite syntax)                                                                | passing (insert, select, update, delete, transactions)                                                               |
| kysely `MysqlDialect` over the callback pool                                                                                                                 | 0.29.7       | passing (SQLite syntax)                                                                | passing (insert, select, update, affected rows)                                                                      |
| drizzle `neon-http` over `neon()` from `@surrealdb/pg/neon` (CRUD, returning, `db.batch` as one atomic call, `$withAuth`, refused interactive transactions)  | 0.45.4       | passing (the driver's `@neondatabase/serverless` import is aliased to the entry point) | not run                                                                                                              |
| drizzle `neon-serverless` over `Pool` from `@surrealdb/pg/neon` (`neonConfig.webSocketConstructor`, CRUD, interactive transactions)                          | 0.45.4       | passing (aliased)                                                                      | not run                                                                                                              |
| drizzle `planetscale-serverless` over `Client` from `@surrealdb/mysql/planetscale` (`instanceof` check, CRUD, transactions with savepoints, `DatabaseError`) | 0.45.4       | passing (SQLite syntax, aliased)                                                       | not run                                                                                                              |
| `@neondatabase/serverless` API surface (`neon` call forms, `fullResults`, `arrayMode`, `authToken`, `fetchOptions`, `neonConfig`)                            |              | unit tests and the PGlite simulator; the vendor package itself is not installed or run | not run                                                                                                              |
| `@planetscale/database` API surface (`execute` with `?` and `:name`, `as`, `cast`, `format`, `ExecutedQuery`, `DatabaseError`)                               |              | unit tests and the SQLite simulator; the vendor package itself is not installed or run | not run                                                                                                              |
| `@prisma/adapter-neon`, `@prisma/adapter-planetscale`, kysely-planetscale                                                                                    |              | not supported: they construct the vendors' own classes                                 |                                                                                                                      |
| Prisma MySQL driver adapters                                                                                                                                 |              | not assessed                                                                           |                                                                                                                      |

The Neon and PlanetScale rows alias the vendor package names to the entry points in the vitest configuration (`vendorAlias`), because Drizzle's drivers import those packages by name. Applications do the same in their bundler.

Where the Neon and PlanetScale options cannot be carried by the engine contract, the entry points refuse or ignore them as follows:

- `neon()` and `transaction()` with `readOnly: true` or `isolationLevel: "Serializable"` throw `UnsupportedOnTransportError`: an atomic `pgsql` call has no option for an isolation level or access mode (only the RPC `begin` method does, and it is interactive). The other levels are accepted and the call runs at the isolation of an atomic call. `deferrable` is ignored.
- `neonConfig` fields which describe Neon's wire protocol (`wsProxy`, `useSecureWebSocket`, `pipelineConnect`, `pipelineTLS`, `coalesceWrites`, `forceDisablePgSSL`, `disableSNI`, `fetchConnectionCache`, `poolQueryViaFetch`, `subtls`, `rootCerts`) are accepted and ignored.
- PlanetScale `transaction(fn)` needs a WebSocket session; with `transport: "http"` it throws `UnsupportedOnTransportError`. `Field` entries carry no column length, character set or flags.
- Neither entry point is verified against the vendor's own package or a real server; the assumption that the engine answers the `pgsql` and `mysql` calls with `valueMode: "text"` and per-entry `vars` in atomic calls follows the contract and the existing integration suites for `batch`.

"Server" is the integration suite run against a debug build of `surrealdb-private` main at `b2b70df36f` (the merge of the `pgsql` and `mysql` RPC methods) with `storage-mem,http,scripting,postgres,mysql`.

## Engine behaviours found against the server

These are behaviours of the instance at `b2b70df36f` that differ from the client contract or from PostgreSQL, found by running the suites. The client works around none of them, except the transaction one in item 3.

1. `RETURNING` with an explicit column list answers its `columns` (and array rows) in name order, not projection order. Drizzle and Prisma read these rows by position, so values land in the wrong fields. A plain `SELECT` with an explicit list is in projection order, and a `*` projection is in name order, as the contract says. The integration suite carries this as an expected failure.
2. With `valueMode: "text"`, integer values of an `integer` column come back with a sized-number suffix such as `30i32`. The node-postgres layer reads `int2` and `int4` with `parseInt`, which stops at the suffix, but an `int8` result is a string that keeps it.
3. `BEGIN ISOLATION LEVEL ...`, `START TRANSACTION READ ONLY` and similar texts are accepted and answer a `SELECT 0` entry without opening a transaction, because only an entry that is exactly `BEGIN` or `START TRANSACTION` is recognised. Drizzle and Kysely send these texts when asked for an isolation level or access mode. The node-postgres layer translates them into the RPC `begin` method with options and carries the returned id as the `txn` of later calls. `@surrealdb/mysql` has no such translation, and the instance accepts `SET TRANSACTION` with no effect.
4. A string parameter is not coerced to the type of the field it is written to: a JSON string for a `jsonb` (object) field, a decimal string for a `numeric` field, and a decimal string for an `int8` beyond 2^53 each fail with a type error. Drizzle sends JSON values as strings.
5. A missing relation is reported as `XX000` with a SurrealDB message, not as `42P01`.

The native APIs and the transports are covered by unit tests with a fake `fetch` and a fake `WebSocket`; the integration suite repeats them against a server.

## Running

```bash
bun install
bun run build           # also needed for the built-output tests
bun run test            # unit
bun run test:compat     # generates the Prisma client, then runs the adapter suites
SURREAL_BIN=/path/to/surreal bun run test:integration
```
