import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** The server binary: `SURREAL_BIN`, else a build in the engine checkout next to this repo. */
export function findBinary(): string | undefined {
    const candidates = [
        process.env.SURREAL_BIN,
        join(homedir(), "Repositories/surrealdb/target/debug/surreal"),
        join(homedir(), "Repositories/surrealdb/target/release/surreal"),
    ];
    return candidates.find((c): c is string => !!c && existsSync(c));
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

export interface RunningServer {
    url: string;
    host: string;
    stop(): Promise<void>;
}

/** Start an in-memory server with root credentials root/root and wait until it is ready. */
export async function startServer(
    binary: string,
    extraArgs: string[] = [],
): Promise<RunningServer> {
    const port = await freePort();
    const child: ChildProcess = spawn(
        binary,
        [
            "start",
            "--bind",
            `127.0.0.1:${port}`,
            "--user",
            "root",
            "--pass",
            "root",
            ...extraArgs,
            "memory",
        ],
        { stdio: "ignore" },
    );
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`surreal exited with code ${child.exitCode}`);
        try {
            if ((await fetch(`${url}/health`)).ok) break;
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            child.kill();
            throw new Error("surreal did not become ready in 30s");
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return {
        url,
        host: `127.0.0.1:${port}`,
        stop: () =>
            new Promise((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.once("exit", () => resolve());
                child.kill();
            }),
    };
}
