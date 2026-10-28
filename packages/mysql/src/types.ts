import { fromBase64, type WireColumn } from "@surrealdb/sql-internal";

/** MySQL protocol column type codes, by the name mysql2 reports. */
export const TYPE_NAMES: Record<number, string> = {
    0: "DECIMAL",
    1: "TINY",
    2: "SHORT",
    3: "LONG",
    4: "FLOAT",
    5: "DOUBLE",
    6: "NULL",
    7: "TIMESTAMP",
    8: "LONGLONG",
    9: "INT24",
    10: "DATE",
    11: "TIME",
    12: "DATETIME",
    13: "YEAR",
    14: "NEWDATE",
    15: "VARCHAR",
    16: "BIT",
    242: "VECTOR",
    245: "JSON",
    246: "NEWDECIMAL",
    247: "ENUM",
    248: "SET",
    249: "TINY_BLOB",
    250: "MEDIUM_BLOB",
    251: "LONG_BLOB",
    252: "BLOB",
    253: "VAR_STRING",
    254: "STRING",
    255: "GEOMETRY",
};

export function typeName(column: WireColumn): string {
    const code = column.type.mysql_type;
    return (
        (code !== undefined ? TYPE_NAMES[code] : undefined) ??
        column.type.name?.toUpperCase() ??
        "VAR_STRING"
    );
}

const INT_TYPES = new Set(["TINY", "SHORT", "LONG", "INT24", "YEAR"]);
const FLOAT_TYPES = new Set(["FLOAT", "DOUBLE"]);
const DATE_TYPES = new Set(["DATE", "DATETIME", "TIMESTAMP", "NEWDATE"]);

export interface MysqlDecodeOptions {
    /** BIGINT beyond the safe range: `auto` returns a string only there (default), `string` for all, `bigint` for all */
    bigint?: "auto" | "string" | "bigint";
    /** DATE, DATETIME and TIMESTAMP as text instead of `Date` */
    dateStrings?: boolean;
    /** DECIMAL as numbers instead of strings */
    decimalNumbers?: boolean;
    cast?: (column: WireColumn, value: unknown) => unknown;
}

function bigintOf(value: string | number, mode: MysqlDecodeOptions["bigint"]): unknown {
    const text = String(value);
    if (mode === "bigint") return BigInt(text);
    if (mode === "string") return text;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
}

/** `YYYY-MM-DD[ hh:mm:ss[.ffffff]]` as local time, the way mysql2 reads it by default. */
export function parseMysqlDate(text: string): Date | null {
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?)?$/.exec(text);
    if (!m) return null;
    if (m[1] === "0000" || m[2] === "00" || m[3] === "00") return null;
    const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    return new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] ?? 0),
        Number(m[5] ?? 0),
        Number(m[6] ?? 0),
        ms,
    );
}

/**
 * Decode a value by its column type. Text-protocol values arrive as strings; native values as
 * JSON values. Both are accepted, so the same decoder serves the native and compatible APIs.
 */
export function decodeMysql(
    value: unknown,
    column: WireColumn,
    options: MysqlDecodeOptions = {},
): unknown {
    if (value === null || value === undefined) return null;
    const name = typeName(column);
    let out: unknown = value;
    if (INT_TYPES.has(name)) out = typeof value === "string" ? Number.parseInt(value, 10) : value;
    else if (name === "LONGLONG") out = bigintOf(value as string | number, options.bigint);
    else if (FLOAT_TYPES.has(name))
        out = typeof value === "string" ? Number.parseFloat(value) : value;
    else if (name === "NEWDECIMAL" || name === "DECIMAL") {
        out = options.decimalNumbers ? Number(value) : String(value);
    } else if (DATE_TYPES.has(name)) {
        if (!options.dateStrings && typeof value === "string") out = parseMysqlDate(value) ?? value;
    } else if (name === "JSON") out = typeof value === "string" ? JSON.parse(value) : value;
    else if (name === "VECTOR")
        out = Array.isArray(value) ? Float32Array.from(value as number[]) : value;
    else if (name.endsWith("BLOB") && typeof value === "string" && column.type.name === "bytea")
        out = fromBase64(value);
    return options.cast ? options.cast(column, out) : out;
}
