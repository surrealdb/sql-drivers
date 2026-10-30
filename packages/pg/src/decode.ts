import { fromBase64, type WireColumn, type WireType } from "@surrealdb/sql-internal";
import { oidByName } from "./oids";
import { RecordId } from "./record-id";

export interface DecodeOptions {
    /** int8 beyond the safe range: `auto` returns bigint only there, `always` for every int8 */
    bigint?: "auto" | "always" | "never";
    /** `string` leaves record ids as `table:key` text */
    recordIds?: "record" | "string";
    /** `array` leaves vectors as number arrays */
    vectors?: "float32" | "array";
    /** Overrides by type name, for example `{ timestamptz: (v) => v }` */
    parse?: Record<string, (raw: unknown, column: WireColumn) => unknown>;
    /** Applied last to every value */
    cast?: (column: WireColumn, value: unknown) => unknown;
}

function asDate(value: unknown, zoned: boolean): unknown {
    if (typeof value !== "string") return value;
    let text = value;
    if (!zoned && !/[zZ]|[+-]\d\d(:?\d\d)?$/.test(text.slice(10))) text += "Z";
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? value : date;
}

const nameByOid = new Map<number, string>(
    Object.entries(oidByName).map(([name, oid]) => [oid, name]),
);

/** Long PostgreSQL type names, as the instance reports them for computed columns, to the short ones. */
const LONG_NAMES: Record<string, string> = {
    bigint: "int8",
    integer: "int4",
    smallint: "int2",
    "double precision": "float8",
    real: "float4",
    boolean: "bool",
    "character varying": "varchar",
    character: "bpchar",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "time without time zone": "time",
    "time with time zone": "timetz",
};

/** The short name of a wire type: from its OID when it has one, else from its name. */
export function canonicalName(type: WireType): string {
    if (type.oid !== undefined) {
        const byOid = nameByOid.get(type.oid);
        if (byOid) return byOid;
    }
    const name = (type.name ?? "").toLowerCase();
    return LONG_NAMES[name] ?? name;
}

function decodeValue(
    value: unknown,
    column: WireColumn,
    options: DecodeOptions,
    type: WireType,
): unknown {
    if (value === null || value === undefined) return null;
    const name = canonicalName(type);
    const custom = options.parse?.[name] ?? (type.name ? options.parse?.[type.name] : undefined);
    if (custom) return custom(value, column);

    if (type.element) {
        if (!Array.isArray(value)) return value;
        return value.map((item) => decodeValue(item, column, options, type.element as WireType));
    }

    let out: unknown;
    switch (name) {
        case "int8": {
            const mode = options.bigint ?? "auto";
            if (typeof value === "string") {
                const big = BigInt(value);
                out = mode === "never" ? Number(big) : big;
            } else if (typeof value === "number") {
                out = mode === "always" ? BigInt(value) : value;
            } else out = value;
            break;
        }
        case "bytea":
            out = typeof value === "string" ? fromBase64(value) : value;
            break;
        case "date":
        case "timestamp":
            out = asDate(value, false);
            break;
        case "timestamptz":
            out = asDate(value, true);
            break;
        case "record":
            out =
                options.recordIds === "string" || typeof value !== "string"
                    ? value
                    : RecordId.parse(value);
            break;
        case "vector":
            out =
                options.vectors === "array" || !Array.isArray(value)
                    ? value
                    : Float32Array.from(value as number[]);
            break;
        default:
            out = value;
    }
    return out;
}

/** Decode a value of the `native` mode by the wire type of its column. */
export function decodeNative(
    value: unknown,
    column: WireColumn,
    options: DecodeOptions = {},
): unknown {
    const out = decodeValue(value, column, options, column.type);
    return options.cast ? options.cast(column, out) : out;
}
