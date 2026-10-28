import type { StatementError } from "@surrealdb/sql-internal";

const CODES: Record<number, string> = {
    1007: "ER_DB_CREATE_EXISTS",
    1008: "ER_DB_DROP_EXISTS",
    1045: "ER_ACCESS_DENIED_ERROR",
    1046: "ER_NO_DB_ERROR",
    1048: "ER_BAD_NULL_ERROR",
    1049: "ER_BAD_DB_ERROR",
    1050: "ER_TABLE_EXISTS_ERROR",
    1051: "ER_BAD_TABLE_ERROR",
    1054: "ER_BAD_FIELD_ERROR",
    1062: "ER_DUP_ENTRY",
    1064: "ER_PARSE_ERROR",
    1146: "ER_NO_SUCH_TABLE",
    1205: "ER_LOCK_WAIT_TIMEOUT",
    1213: "ER_LOCK_DEADLOCK",
    1216: "ER_NO_REFERENCED_ROW",
    1217: "ER_ROW_IS_REFERENCED",
    1317: "ER_QUERY_INTERRUPTED",
    1400: "ER_XA_RMERR",
    1451: "ER_ROW_IS_REFERENCED_2",
    1452: "ER_NO_REFERENCED_ROW_2",
};

/** The error shape mysql2 raises for a server-side failure. */
export class MysqlError extends Error {
    override name = "Error";
    code: string;
    errno: number;
    sqlState: string;
    sqlMessage: string;
    fatal = false;
    sql: string | undefined;

    constructor(message: string, errno: number, sqlState: string, sql?: string) {
        super(`${CODES[errno] ?? "ER_UNKNOWN"}: ${message}`);
        this.code = CODES[errno] ?? "ER_UNKNOWN";
        this.errno = errno;
        this.sqlState = sqlState;
        this.sqlMessage = message;
        this.sql = sql;
    }

    static from(error: StatementError, sql?: string): MysqlError {
        return new MysqlError(error.message, error.errno ?? 1105, error.sqlstate ?? "HY000", sql);
    }
}
