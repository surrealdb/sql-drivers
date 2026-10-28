import { FakeSocket, routing } from "@surrealdb/sql-internal/testing";
import { PgliteEngine } from "../../../../test-support/pglite-engine";

export async function startEngine() {
    const engine = await PgliteEngine.create();
    FakeSocket.reset(routing((m, p) => engine.handle("ws", m, p)));
    const options = {
        connectionString: "postgres://root:root@localhost/app?ns=t",
        WebSocket: FakeSocket as never,
        fetch: engine.fetch,
    };
    return { engine, options };
}
