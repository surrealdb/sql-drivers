# sql-drivers

SurrealDB clients for the PostgreSQL and MySQL dialects, for serverless, edge and browser runtimes where TCP is unavailable.

| Package                              | Dialect    | RPC method |
| ------------------------------------ | ---------- | ---------- |
| [`@surrealdb/pg`](packages/pg)       | PostgreSQL | `pgsql`    |
| [`@surrealdb/mysql`](packages/mysql) | MySQL      | `mysql`    |

Both send SQL text to an instance over HTTP (one-shot and atomic batch) or WebSocket (sessions, interactive transactions, live queries). Each has a native API and a compatibility layer for existing ORMs and query builders.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Compatibility and how each adapter is verified: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)

Native clients over TCP (`pg`, `mysql2`) connect to the PostgreSQL and MySQL wire listeners of an instance instead.

## Development

```bash
bun install
bun run qc && bun run qts && bun run test
```

## Licence

Apache-2.0.
