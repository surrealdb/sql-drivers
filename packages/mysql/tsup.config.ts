import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        callback: "src/compat/callback.ts",
        planetscale: "src/planetscale/index.ts",
    },
    format: ["esm"],
    dts: false,
    clean: true,
    target: "es2022",
    platform: "neutral",
    keepNames: true,
    treeshake: true,
    noExternal: ["@surrealdb/sql-internal"],
});
