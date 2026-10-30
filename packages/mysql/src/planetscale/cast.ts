/** A result column, in the shape the PlanetScale driver reports. */
export interface Field {
    name: string;
    /** The Vitess type name, for example `INT32`, `VARCHAR` or `DATETIME` */
    type: string | null;
    table: string | null;
    orgTable: string | null;
    database: string | null;
    orgName: string | null;
    columnLength: number | null;
    charset: number | null;
    flags: number | null;
}

export type Cast = (field: Field, value: string | null) => unknown;

/**
 * The default conversion of a text value by column type: integers and floats to numbers, JSON
 * parsed, and everything else, including 64-bit integers, decimals and dates, left as text.
 */
export function cast(field: Field, value: string | null): unknown {
    if (value === null || value === undefined) return null;
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
            return value;
    }
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
