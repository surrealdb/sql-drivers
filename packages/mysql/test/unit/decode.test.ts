import { buildResults, decodeMysql } from "@surrealdb/mysql";
import type { WireColumn } from "@surrealdb/sql-internal";
import { describe, expect, it } from "vitest";

const col = (name: string, mysql_type: number): WireColumn => ({
    name,
    type: { mysql_type },
    nullable: null,
    table: null,
    column: null,
});

describe("decodeMysql", () => {
    it("decodes text and native values by protocol type", () => {
        expect(decodeMysql("42", col("a", 3))).toBe(42);
        expect(decodeMysql(42, col("a", 3))).toBe(42);
        expect(decodeMysql("1.5", col("a", 5))).toBe(1.5);
        expect(decodeMysql("12.50", col("a", 246))).toBe("12.50");
        expect(decodeMysql("12.50", col("a", 246), { decimalNumbers: true })).toBe(12.5);
        expect(decodeMysql('{"a":1}', col("a", 245))).toEqual({ a: 1 });
        expect(decodeMysql(null, col("a", 3))).toBeNull();
    });

    it("keeps BIGINT exact beyond the safe range", () => {
        expect(decodeMysql("5", col("a", 8))).toBe(5);
        expect(decodeMysql("9223372036854775807", col("a", 8))).toBe("9223372036854775807");
        expect(decodeMysql("5", col("a", 8), { bigint: "bigint" })).toBe(5n);
    });

    it("reads dates as local time unless asked for strings, and zero dates as the raw text", () => {
        expect(decodeMysql("2026-01-02 03:04:05", col("a", 12))).toEqual(
            new Date(2026, 0, 2, 3, 4, 5),
        );
        expect(decodeMysql("2026-01-02", col("a", 10))).toEqual(new Date(2026, 0, 2));
        expect(decodeMysql("2026-01-02 03:04:05", col("a", 12), { dateStrings: true })).toBe(
            "2026-01-02 03:04:05",
        );
        expect(decodeMysql("0000-00-00", col("a", 10))).toBe("0000-00-00");
    });
});

describe("buildResults", () => {
    it("builds rows, command, row count and insert id", () => {
        const [r] = buildResults({
            statements: [
                {
                    status: "OK",
                    command: { tag: "INSERT", rows_affected: 1, last_insert_id: 7, warnings: 2 },
                    columns: [],
                    rows: [],
                },
            ],
            transaction: { status: "idle" },
        }) as any[];
        expect(r).toMatchObject({ command: "INSERT", rowCount: 1, insertId: 7, warnings: 2 });
    });

    it("throws the first statement error carrying the errno", () => {
        expect(() =>
            buildResults({
                statements: [
                    { status: "ERR", error: { message: "dup", sqlstate: "23000", errno: 1062 } },
                ],
                transaction: { status: "idle" },
            }),
        ).toThrow(expect.objectContaining({ errno: 1062, sqlstate: "23000" }));
    });
});
