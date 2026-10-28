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
export * from "./native";
export { decodeMysql, type MysqlDecodeOptions, TYPE_NAMES } from "./types";
