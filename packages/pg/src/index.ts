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
export { type DecodeOptions, decodeNative } from "./decode";
export * from "./native";
export { builtins } from "./oids";
export { RecordId, recordId } from "./record-id";
export { TypeOverrides, types } from "./text-types";
