import { escapeId, prepare } from "@surrealdb/mysql";
import { describe, expect, it } from "vitest";

describe("prepare", () => {
    it("binds ? placeholders and keeps them out of strings and comments", () => {
        expect(prepare("select '?' as q, ? as a -- ?\n, ? as b /* ? */", [1, 2], false)).toEqual({
            text: "select '?' as q, ? as a -- ?\n, ? as b /* ? */",
            params: [1, 2],
        });
    });

    it("expands arrays for query but not execute", () => {
        expect(prepare("select * from t where id in (?)", [[1, 2, 3]], true)).toEqual({
            text: "select * from t where id in (?, ?, ?)",
            params: [1, 2, 3],
        });
        expect(
            prepare(
                "insert into t values ?",
                [
                    [
                        [1, "a"],
                        [2, "b"],
                    ],
                ],
                true,
            ),
        ).toEqual({ text: "insert into t values (?, ?), (?, ?)", params: [1, "a", 2, "b"] });
        expect(prepare("select ?", [[1, 2]], false).params).toEqual([[1, 2]]);
    });

    it("quotes identifiers for ??", () => {
        expect(prepare("select ?? from ??", ["a`b", "db.t"], true).text).toBe(
            "select `a``b` from `db`.`t`",
        );
        expect(escapeId(["a", "b"])).toBe("`a`, `b`");
    });

    it("rejects too few values and maps undefined to null", () => {
        expect(() => prepare("select ?, ?", [1], true)).toThrow(/fewer/);
        expect(prepare("select ?", [undefined], true).params).toEqual([null]);
    });
});
