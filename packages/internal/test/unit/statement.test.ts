import { buildVars, encodeParam, Raw, render, Statement } from "@surrealdb/sql-internal";
import { describe, expect, it } from "vitest";

const pg = (n: number) => `$${n}`;
const run = async () => 1;

describe("render", () => {
    it("numbers placeholders in order", () => {
        const s = Statement.template(
            ["SELECT * FROM t WHERE a = ", " AND b = ", ""],
            ["x", 2],
            run,
        );
        expect(render(s, pg)).toEqual({
            text: "SELECT * FROM t WHERE a = $1 AND b = $2",
            params: ["x", 2],
        });
    });

    it("inlines nested statements sharing one counter, and raw text", () => {
        const inner = Statement.template(["b = ", ""], [2], run);
        const s = Statement.template(
            ["SELECT 1 WHERE a = ", " AND ", " ORDER BY ", " LIMIT ", ""],
            [1, inner, new Raw("name"), 5],
            run,
        );
        expect(render(s, pg)).toEqual({
            text: "SELECT 1 WHERE a = $1 AND b = $2 ORDER BY name LIMIT $3",
            params: [1, 2, 5],
        });
    });

    it("uses ? for the mysql dialect", () => {
        const s = Statement.template(["a = ", " AND b = ", ""], [1, 2], run);
        expect(render(s, () => "?").text).toBe("a = ? AND b = ?");
    });

    it("refuses to nest a direct statement", () => {
        const direct = Statement.direct("b = $1", [2], run);
        const s = Statement.template(["a = ", ""], [direct], run);
        expect(() => render(s, pg)).toThrow(/cannot be nested/);
    });

    it("runs lazily and once", async () => {
        let runs = 0;
        const s = Statement.template(["x"], [], async () => ++runs);
        expect(runs).toBe(0);
        expect(await s).toBe(1);
        expect(await s).toBe(1);
        expect(runs).toBe(1);
    });
});

describe("encoding", () => {
    it("encodes values for JSON", () => {
        expect(encodeParam(undefined)).toBeNull();
        expect(encodeParam(5n)).toBe(5);
        expect(encodeParam(2n ** 63n)).toBe("9223372036854775808");
        expect(encodeParam(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
        expect(encodeParam(new Uint8Array([1, 2, 3]))).toBe("AQID");
    });

    it("builds _n vars", () => {
        expect(buildVars([])).toBeUndefined();
        expect(buildVars(["a", 2])).toEqual({ _1: "a", _2: 2 });
    });
});
