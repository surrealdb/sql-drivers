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
export * from "./compat/index";
export { type DecodeOptions, decodeNative } from "./decode";
export * from "./native";
export { type NeonConfig, neonConfig } from "./neon/config";
export { NeonDbError } from "./neon/errors";
export {
    type FullQueryResults,
    type HTTPQueryOptions,
    type HTTPTransactionOptions,
    type NeonQueryFunction,
    NeonQueryPromise,
    neon,
} from "./neon/http";
export { builtins } from "./oids";
export { RecordId, recordId } from "./record-id";
export { TypeOverrides, types } from "./text-types";
