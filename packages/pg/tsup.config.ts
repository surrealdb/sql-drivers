import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/index.ts", compat: "src/compat/index.ts", neon: "src/neon/index.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    target: "es2022",
    platform: "neutral",
    keepNames: true,
    treeshake: true,
    noExternal: ["@surrealdb/sql-internal"],
});
