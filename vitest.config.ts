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

// Drizzle's neon and planetscale drivers import the vendors' packages by name; the compat suites
// resolve those names to the drop-in entry points of this repository.
const vendorAlias = {
    "@neondatabase/serverless": fileURLToPath(
        new URL("./packages/pg/src/neon/index.ts", import.meta.url),
    ),
    "@planetscale/database": fileURLToPath(
        new URL("./packages/mysql/src/planetscale/index.ts", import.meta.url),
    ),
};

export default defineConfig({
    test: {
        projects: [
            {
                resolve: { alias },
                test: { name: "unit", include: ["packages/*/test/unit/**/*.test.ts"] },
            },
            {
                resolve: { alias: { ...vendorAlias, ...alias } },
                test: {
                    name: "compat",
                    include: ["packages/*/test/compat/**/*.test.ts"],
                    testTimeout: 30_000,
                    server: { deps: { inline: ["drizzle-orm"] } },
                },
            },
            {
                resolve: { alias },
                test: {
                    name: "conformance",
                    include: ["packages/*/test/conformance/**/*.test.ts"],
                    testTimeout: 30_000,
                    hookTimeout: 60_000,
                },
            },
            {
                resolve: { alias: { ...vendorAlias, ...alias } },
                test: {
                    name: "integration",
                    include: ["packages/*/test/integration/**/*.test.ts"],
                    testTimeout: 30_000,
                    hookTimeout: 60_000,
                    server: { deps: { inline: ["drizzle-orm"] } },
                },
            },
        ],
    },
});
