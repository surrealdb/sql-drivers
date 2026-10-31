import * as vendor from "@neondatabase/serverless";
import { neonFake } from "../../../../test-support/neon-fake";
import { PgliteEngine } from "../../../../test-support/pglite-engine";
import * as ours from "../../src/neon/index";

export const URL = "postgres://root:root@localhost/app?ns=t";

/** The package under test: the vendor's own, or this repository's entry point. */
export type Neon = typeof vendor;

export interface Subject {
    name: "vendor" | "ours";
    lib: Neon;
    /** Fresh engine and a `fetch` which reaches it in the form the subject's backend speaks */
    start(): Promise<{ fetch: typeof fetch; engine: PgliteEngine; requests: unknown[] }>;
}

export const subjects: Subject[] = [
    {
        name: "vendor",
        lib: vendor,
        async start() {
            const engine = await PgliteEngine.create();
            const fake = neonFake(engine);
            return { fetch: fake.fetch, engine, requests: fake.requests };
        },
    },
    {
        name: "ours",
        lib: ours as unknown as Neon,
        async start() {
            const engine = await PgliteEngine.create();
            return { fetch: engine.fetch, engine, requests: engine.stats.calls };
        },
    },
];
