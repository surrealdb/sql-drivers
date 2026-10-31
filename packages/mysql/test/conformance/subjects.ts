import * as v2 from "@planetscale/database";
import { FakeSocket, routing } from "@surrealdb/sql-internal/testing";
import * as v1 from "planetscale-v1";
import { planetscaleFake } from "../../../../test-support/planetscale-fake";
import { SqliteMysqlEngine } from "../../../../test-support/sqlite-mysql-engine";
import * as ours from "../../src/planetscale/index";

export const HOST = "localhost";
export const URL = "mysql://root:root@localhost/app?ns=t";

/** The shape the three packages share; `Client` calls differ in what `execute` accepts */
export type Lib = typeof v2 & { format?: (query: string, args: unknown) => string };

export interface Subject {
    name: "vendor 2.0.0" | "vendor 1.20.2" | "ours";
    /** Whether `execute(query, args, options)` and `Config.format` exist */
    args: boolean;
    lib: Lib;
    start(): Promise<{
        config: Record<string, unknown>;
        engine: SqliteMysqlEngine;
        requests: unknown[];
    }>;
}

async function vendorStart() {
    const engine = new SqliteMysqlEngine();
    const fake = planetscaleFake(engine);
    return {
        engine,
        requests: fake.requests,
        config: { url: URL.replace("mysql://", "https://"), fetch: fake.fetch },
    };
}

export const subjects: Subject[] = [
    { name: "vendor 2.0.0", args: false, lib: v2 as Lib, start: vendorStart },
    { name: "vendor 1.20.2", args: true, lib: v1 as unknown as Lib, start: vendorStart },
    {
        name: "ours",
        args: true,
        lib: ours as unknown as Lib,
        async start() {
            const engine = new SqliteMysqlEngine();
            FakeSocket.reset(routing((m, p) => engine.handle("ws", m, p)));
            return {
                engine,
                requests: engine.calls,
                config: { url: URL, fetch: engine.fetch, WebSocket: FakeSocket },
            };
        },
    },
];
