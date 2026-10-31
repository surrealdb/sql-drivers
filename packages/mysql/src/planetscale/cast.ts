/** A result column, in the shape the PlanetScale driver reports. */
export interface Field {
    name: string;
    /** The Vitess type name, for example `INT32`, `VARCHAR` or `DATETIME` */
    type: string;
    table?: string;
    orgTable?: string | null;
    database?: string | null;
    orgName?: string | null;
    /** The display width in bytes; the MySQL protocol default of the type until the instance reports it */
    columnLength?: number | null;
    /** The MySQL collation id: 63 for binary, 255 (utf8mb4) for text, as the type implies */
    charset?: number | null;
    decimals?: number;
    /** The MySQL column flag bits: `NOT_NULL` (1), `BLOB` (16), `BINARY` (128), `NUM` (32768) */
    flags?: number | null;
    columnType?: string | null;
}

export type Cast = (field: Field, value: any) => any;

/**
 * The default conversion of a text value by column type: integers and floats to numbers, JSON
 * parsed, and everything else, including 64-bit integers, decimals and dates, left as text.
 */
export function cast(field: Field, value: any): any {
    if (value === null || value === undefined) return null;
    if (value instanceof Uint8Array) {
        return field.charset === 63 ? value : new TextDecoder().decode(value);
    }
    switch (field.type) {
        case "INT8":
        case "INT16":
        case "INT24":
        case "INT32":
        case "UINT8":
        case "UINT16":
        case "UINT24":
        case "UINT32":
        case "YEAR":
            return Number.parseInt(value, 10);
        case "FLOAT32":
        case "FLOAT64":
            return Number.parseFloat(value);
        case "JSON":
            return JSON.parse(value);
        default:
            return field.charset === 63 && BINARY.has(field.type)
                ? new TextEncoder().encode(value)
                : value;
    }
}

const BINARY = new Set(["BLOB", "BINARY", "VARBINARY"]);

const NUM = 32768;
const NOT_NULL = 1;
const BLOB = 16;
const BINARY_FLAG = 128;

interface Shape {
    length: number;
    charset: number;
    flags: number;
    decimals: number;
}

const num = (length: number, decimals = 0): Shape => ({
    length,
    charset: 63,
    flags: NUM,
    decimals,
});
const text = (length: number): Shape => ({ length, charset: 255, flags: 0, decimals: 0 });
const when = (length: number): Shape => ({ length, charset: 63, flags: 0, decimals: 0 });

/**
 * What the MySQL protocol reports for a column of the type when the declaration is not known:
 * the protocol's default display width, collation (63 binary, 255 utf8mb4) and flag bits. The
 * contract carries the type and nullability only, so these are derived, not read.
 */
const SHAPES: Record<string, Shape> = {
    INT8: num(4),
    INT16: num(6),
    INT24: num(9),
    INT32: num(11),
    INT64: num(20),
    UINT8: num(3),
    UINT16: num(5),
    UINT24: num(8),
    UINT32: num(10),
    UINT64: num(20),
    FLOAT32: num(12, 31),
    FLOAT64: num(22, 31),
    DECIMAL: num(12),
    YEAR: num(4),
    DATE: when(10),
    TIME: when(10),
    DATETIME: when(19),
    TIMESTAMP: when(19),
    JSON: { length: 4294967295, charset: 63, flags: BLOB | BINARY_FLAG, decimals: 0 },
    BLOB: { length: 65535, charset: 63, flags: BLOB | BINARY_FLAG, decimals: 0 },
    BINARY: { length: 255, charset: 63, flags: BINARY_FLAG, decimals: 0 },
    VARBINARY: { length: 255, charset: 63, flags: BINARY_FLAG, decimals: 0 },
    BIT: when(1),
    VARCHAR: text(1020),
    CHAR: text(1020),
    ENUM: text(1020),
    SET: text(1020),
};

/** Column length, collation, flags and decimals for a Vitess type name and nullability. */
export function columnShape(type: string, nullable: boolean | null) {
    const shape = SHAPES[type] ?? text(1020);
    return {
        columnLength: shape.length,
        charset: shape.charset,
        flags: shape.flags | (nullable === false ? NOT_NULL : 0),
        decimals: shape.decimals,
    };
}

/** A binary-literal text for a parameter, as `@planetscale/database` exports it. */
export function hex(text: string): string {
    let out = "0x";
    for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(2, "0");
    return out;
}

const VITESS: Record<string, string> = {
    TINY: "INT8",
    SHORT: "INT16",
    INT24: "INT24",
    LONG: "INT32",
    LONGLONG: "INT64",
    FLOAT: "FLOAT32",
    DOUBLE: "FLOAT64",
    DECIMAL: "DECIMAL",
    NEWDECIMAL: "DECIMAL",
    TIMESTAMP: "TIMESTAMP",
    DATE: "DATE",
    NEWDATE: "DATE",
    TIME: "TIME",
    DATETIME: "DATETIME",
    YEAR: "YEAR",
    JSON: "JSON",
    ENUM: "ENUM",
    SET: "SET",
    TINY_BLOB: "BLOB",
    MEDIUM_BLOB: "BLOB",
    LONG_BLOB: "BLOB",
    BLOB: "BLOB",
    VARCHAR: "VARCHAR",
    VAR_STRING: "VARCHAR",
    STRING: "CHAR",
    BIT: "BIT",
    GEOMETRY: "GEOMETRY",
    NULL: "NULL",
};

/** The Vitess type name for a protocol type name. */
export function vitessType(protocolName: string): string {
    return VITESS[protocolName] ?? protocolName;
}

/** The text a driver value has on the PlanetScale wire, which every value crosses as. */
export function textOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? "1" : "0";
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}
