import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
    "@surrealdb/sql-internal/testing": fileURLToPath(
        new URL("./packages/internal/src/testing", import.meta.url),
    ),
    "@surrealdb/sql-internal": fileURLToPath(new URL("./packages/internal/src", import.meta.url)),
    "@surrealdb/pg": fileURLToPath(new URL("./packages/pg/src", import.meta.url)),
    "@surrealdb/mysql/callback": fileURLToPath(
        new URL("./packages/mysql/src/compat/callback.ts", import.meta.url),
    ),
    "@surrealdb/mysql": fileURLToPath(new URL("./packages/mysql/src", import.meta.url)),
};

export default defineConfig({
    test: {
        projects: [
            {
                resolve: { alias },
                test: { name: "unit", include: ["packages/*/test/unit/**/*.test.ts"] },
            },
            {
                resolve: { alias },
                test: {
                    name: "compat",
                    include: ["packages/*/test/compat/**/*.test.ts"],
                    testTimeout: 30_000,
                },
            },
            {
                resolve: { alias },
                test: {
                    name: "integration",
                    include: ["packages/*/test/integration/**/*.test.ts"],
                    testTimeout: 30_000,
                    hookTimeout: 60_000,
                },
            },
        ],
    },
});
