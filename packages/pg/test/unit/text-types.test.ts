import { types } from "@surrealdb/pg";
import { describe, expect, it } from "vitest";
import { parseArray, parseBytea, parseDate } from "../../src/text-types";

describe("text parsers", () => {
    it("parses nested arrays with quoting, NULL and escapes", () => {
        expect(parseArray('{1,NULL,"a,b","q\\"x"}', (v) => v)).toEqual(["1", null, "a,b", 'q"x']);
        expect(parseArray("{{1,2},{3,4}}", Number)).toEqual([
            [1, 2],
            [3, 4],
        ]);
        expect(parseArray("{}", Number)).toEqual([]);
        expect(parseArray('{"NULL"}', (v) => v)).toEqual(["NULL"]);
    });

    it("parses timestamps with zones and fractions, and infinity", () => {
        expect(parseDate("2026-01-02 03:04:05.5+02")).toEqual(new Date("2026-01-02T01:04:05.500Z"));
        expect(parseDate("2026-01-02 03:04:05Z")).toEqual(new Date("2026-01-02T03:04:05Z"));
        expect(parseDate("2026-01-02 03:04:05")).toEqual(new Date(2026, 0, 2, 3, 4, 5));
        expect(parseDate("infinity")).toBe(Number.POSITIVE_INFINITY);
        expect(parseDate("not a date")).toBe("not a date");
    });

    it("parses bytea hex and escape formats", () => {
        expect(parseBytea("\\x010203")).toEqual(new Uint8Array([1, 2, 3]));
        expect(parseBytea("a\\\\b\\001")).toEqual(new Uint8Array([97, 92, 98, 1]));
    });

    it("types.getTypeParser works detached and keeps int8 and numeric as strings", () => {
        const { getTypeParser } = types;
        expect(getTypeParser(20)("9007199254740993")).toBe("9007199254740993");
        expect(getTypeParser(1700)("1.10")).toBe("1.10");
        expect(getTypeParser(1007)("{1,2}")).toEqual([1, 2]);
        expect(getTypeParser(16)("t")).toBe(true);
    });
});
