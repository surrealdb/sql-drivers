export {
    Connection,
    type ConnectionConfig,
    createConnection,
    createPool,
    type FieldPacket,
    Pool,
    type PoolConnection,
    type QueryOptions as QueryConfig,
    type QueryReply,
    type ResultSetHeader,
    type TypeCast,
    type TypeCastField,
    toConnectOptions,
} from "./connection";
export { MysqlError } from "./errors";
export { escapeId, prepare } from "./prepare";
