import { arrayElements, builtins } from "./oids";

export type TextParser = (value: string) => unknown;

const DATE_RE =
    /^(\d{4,})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?)?(?:(Z)|([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?)?( BC)?$/;

/** Parse the text form of date, timestamp and timestamptz. Timestamps without a zone are local. */
export function parseDate(value: string): Date | number | string {
    if (value === "infinity") return Number.POSITIVE_INFINITY;
    if (value === "-infinity") return Number.NEGATIVE_INFINITY;
    const m = DATE_RE.exec(value);
    if (!m) return value;
    let year = Number(m[1]);
    if (m[13]) year = 1 - year;
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hour = Number(m[4] ?? 0);
    const minute = Number(m[5] ?? 0);
    const second = Number(m[6] ?? 0);
    const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    const hasZone = m[8] !== undefined || m[9] !== undefined;
    let date: Date;
    if (hasZone) {
        const sign = m[9] === "-" ? -1 : 1;
        const offsetSeconds =
            m[8] !== undefined
                ? 0
                : sign * (Number(m[10]) * 3600 + Number(m[11] ?? 0) * 60 + Number(m[12] ?? 0));
        date = new Date(
            Date.UTC(year, month, day, hour, minute, second, ms) - offsetSeconds * 1000,
        );
        if (year >= 0 && year < 100) date.setUTCFullYear(year);
    } else {
        date = new Date(year, month, day, hour, minute, second, ms);
        if (year >= 0 && year < 100) date.setFullYear(year);
    }
    return date;
}

export function parseBytea(value: string): Uint8Array {
    if (value.startsWith("\\x")) {
        const hex = value.slice(2);
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }
    // Escape format
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === "\\") {
            if (value[i + 1] === "\\") {
                bytes.push(0x5c);
                i++;
            } else {
                bytes.push(Number.parseInt(value.substr(i + 1, 3), 8));
                i += 3;
            }
        } else bytes.push(ch.charCodeAt(0));
    }
    return Uint8Array.from(bytes);
}

/**
 * Parse a PostgreSQL array literal such as `{1,2,NULL,"a b"}` into a nested array, parsing
 * each element with `element`. Elements are not parsed when they are NULL.
 */
export function parseArray(literal: string, element: TextParser): unknown[] {
    let pos = 0;
    // An optional dimension decoration `[1:3]=` precedes the braces
    if (literal[0] === "[") pos = literal.indexOf("=") + 1;
    const parseLevel = (): unknown[] => {
        const out: unknown[] = [];
        pos++; // {
        while (pos < literal.length) {
            const ch = literal[pos];
            if (ch === "}") {
                pos++;
                return out;
            }
            if (ch === ",") {
                pos++;
                continue;
            }
            if (ch === "{") {
                out.push(parseLevel());
                continue;
            }
            if (ch === '"') {
                pos++;
                let text = "";
                while (pos < literal.length && literal[pos] !== '"') {
                    if (literal[pos] === "\\") pos++;
                    text += literal[pos++];
                }
                pos++;
                out.push(element(text));
                continue;
            }
            let end = pos;
            while (end < literal.length && literal[end] !== "," && literal[end] !== "}") end++;
            const raw = literal.slice(pos, end);
            pos = end;
            out.push(raw === "NULL" ? null : element(raw));
        }
        return out;
    };
    return parseLevel();
}

const identity: TextParser = (v) => v;

const base: Record<number, TextParser> = {
    [builtins.BOOL]: (v) => v === "t" || v === "true",
    [builtins.BYTEA]: parseBytea,
    [builtins.INT2]: (v) => Number.parseInt(v, 10),
    [builtins.INT4]: (v) => Number.parseInt(v, 10),
    [builtins.OID]: (v) => Number.parseInt(v, 10),
    [builtins.FLOAT4]: Number.parseFloat,
    [builtins.FLOAT8]: Number.parseFloat,
    [builtins.JSON]: (v) => JSON.parse(v),
    [builtins.JSONB]: (v) => JSON.parse(v),
    [builtins.DATE]: parseDate,
    [builtins.TIMESTAMP]: parseDate,
    [builtins.TIMESTAMPTZ]: parseDate,
};

export type ParserFormat = "text" | "binary";

/**
 * Per-instance type parsers with the `getTypeParser` and `setTypeParser` shape of node-postgres,
 * for text-format values. int8 and numeric stay strings, as in node-postgres.
 */
export class TypeOverrides {
    #parsers = new Map<number, TextParser>();

    getTypeParser(oid: number, _format: ParserFormat = "text"): TextParser {
        const own = this.#parsers.get(oid);
        if (own) return own;
        const direct = base[oid];
        if (direct) return direct;
        const element = arrayElements[oid];
        if (element !== undefined) {
            const parse = this.getTypeParser(element);
            return (v) => parseArray(v, parse);
        }
        return identity;
    }

    setTypeParser(oid: number, parser: TextParser): void;
    setTypeParser(oid: number, format: ParserFormat, parser: TextParser): void;
    setTypeParser(oid: number, a: ParserFormat | TextParser, b?: TextParser): void {
        const parser = typeof a === "function" ? a : b;
        if (parser) this.#parsers.set(oid, parser);
    }
}

const defaults = new TypeOverrides();

/** The default parsers, shared like `pg.types`; the methods work detached from the object. */
export const types = {
    getTypeParser: (oid: number, format: ParserFormat = "text"): TextParser =>
        defaults.getTypeParser(oid, format),
    setTypeParser: (oid: number, a: ParserFormat | TextParser, b?: TextParser): void =>
        defaults.setTypeParser(oid, a as ParserFormat, b as TextParser),
    builtins,
};
