# Compatibility matrix

"Simulator" means the real adapter code runs against a contract simulator in `test-support/`: PGlite (a real PostgreSQL) for `@surrealdb/pg` and SQLite for `@surrealdb/mysql`, both behind the `pgsql` and `mysql` RPC shapes of the engine's client contract. It verifies call forms, result shapes, `instanceof` checks, type parsers and transaction handling. It does not verify engine behaviour: SQL dialect coverage, value encodings, SQLSTATE mapping or OIDs. "Server" means the integration suite against a built `surreal` binary, which cannot run until a build serves the methods.

| Adapter                                                                                                                                | Version read | Simulator                                                                    | Server  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------- | ------- |
| drizzle-orm `node-postgres` (Pool and Client: CRUD, returning, timestamps, jsonb, bigint, transactions with savepoints, migrator)      | 0.45.4       | passing                                                                      | not run |
| kysely `PostgresDialect` (DDL, returning, affected rows from `command`, transactions with isolation, raw sql)                          | 0.29.7       | passing                                                                      | not run |
| real `pg.Pool` with `{ Client }` (instanceof, `types`, `rowMode`, pinned transactions, error fields)                                   | pg 8.23.1    | passing                                                                      | not run |
| `@prisma/adapter-pg` over `pg.Pool({ Client })` (nested create, relation joins, P2002, interactive and batch transactions)             | 7.10.1       | passing                                                                      | not run |
| drizzle-orm `mysql2` (CRUD, `typeCast` for datetime, `execute`, transactions, error shape)                                             | 0.45.4       | passing (SQLite syntax)                                                      | not run |
| kysely `MysqlDialect` over the callback pool                                                                                           | 0.29.7       | passing (SQLite syntax)                                                      | not run |
| drizzle `neon-http` through a `neon()`-shaped function                                                                                 |              | not built                                                                    | not run |
| drizzle `neon-serverless`, drizzle `planetscale-serverless`, `@prisma/adapter-neon`, `@prisma/adapter-planetscale`, kysely-planetscale |              | not supported: they construct or `instanceof`-check the vendors' own classes |         |
| Prisma MySQL driver adapters                                                                                                           |              | not assessed                                                                 |         |

The native APIs and the transports are covered by unit tests with a fake `fetch` and a fake `WebSocket`; the integration suite repeats them against a server.

## Running

```bash
bun install
bun run build           # also needed for the built-output tests
bun run test            # unit
bun run test:compat     # generates the Prisma client, then runs the adapter suites
SURREAL_BIN=/path/to/surreal bun run test:integration
```
