import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../dist");
const built = existsSync(join(dist, "index.js"));

describe.skipIf(!built)("built output of @surrealdb/pg", () => {
    it("has no Node built-in imports, so it runs on edge runtimes and in browsers", () => {
        for (const file of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
            const code = readFileSync(join(dist, file), "utf8");
            expect(code, file).not.toMatch(/from\s+["']node:/);
            expect(code, file).not.toMatch(/require\(["']node:/);
            expect(code, file).not.toMatch(/\bBuffer\b/);
        }
    });

    it("does not reference the internal package, which is not published", () => {
        for (const file of readdirSync(dist)) {
            expect(readFileSync(join(dist, file), "utf8"), file).not.toContain("sql-internal");
        }
    });

    it("keeps class names, which drizzle reads to detect a pool", async () => {
        const mod = await import(join(dist, "index.js"));
        expect(mod.Pool.name).toBe("Pool");
    });
});
