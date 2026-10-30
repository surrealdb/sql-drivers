export {
    AbortError,
    AuthError,
    CapabilityDeniedError,
    ConnectionError,
    ConnectionLostError,
    RpcError,
    StatementError,
    SurrealSqlError,
    TimeoutError,
    UnknownResponseError,
    UnsupportedOnTransportError,
} from "@surrealdb/sql-internal";
export type {
    ClientConfig,
    FieldDef,
    PoolClient,
    PoolConfig,
    QueryConfig,
    QueryResult,
} from "../compat/index";
export { DatabaseError } from "../compat/index";
export { builtins } from "../oids";
export { TypeOverrides, types } from "../text-types";
export { type NeonConfig, neonConfig } from "./config";
export { NeonDbError } from "./errors";
export { escapeIdentifier, escapeLiteral } from "./escape";
export {
    type AuthToken,
    type FullQueryResults,
    type HTTPQueryOptions,
    type HTTPTransactionOptions,
    type NeonIsolationLevel,
    type NeonOptions,
    type NeonQueryFunction,
    type NeonQueryInTransaction,
    NeonQueryPromise,
    neon,
    type QueryRows,
    UnsafeRawSql,
} from "./http";
export { Client, Pool } from "./ws";
