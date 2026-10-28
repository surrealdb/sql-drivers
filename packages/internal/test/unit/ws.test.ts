import {
    ConnectionLostError,
    resolveConfig,
    TimeoutError,
    WsTransport,
} from "@surrealdb/sql-internal";
import { describe, expect, it, vi } from "vitest";

class FakeSocket extends EventTarget {
    static instances: FakeSocket[] = [];
    static onSend: (socket: FakeSocket, message: any) => void = () => {};
    readyState = 0;
    sent: any[] = [];
    constructor(
        public url: string,
        public protocols?: string[],
    ) {
        super();
        FakeSocket.instances.push(this);
        queueMicrotask(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        });
    }
    send(data: string) {
        const message = JSON.parse(data);
        this.sent.push(message);
        FakeSocket.onSend(this, message);
    }
    reply(message: unknown) {
        this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
    }
    close() {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
    }
}

function make(extra = {}) {
    FakeSocket.instances = [];
    FakeSocket.onSend = (socket, m) =>
        socket.reply({ id: m.id, result: m.method === "signin" ? "tok" : { echo: m.method } });
    const config = resolveConfig(
        {
            url: "postgres://root:root@localhost/app?ns=prod",
            WebSocket: FakeSocket as any,
            reconnect: { retryDelay: 1, retryDelayJitter: 0, attempts: 2 },
            ...extra,
        },
        "pg",
    );
    return new WsTransport(config);
}

describe("WsTransport", () => {
    it("opens with the json subprotocol, selects ns/db and signs in before the first call", async () => {
        const t = make();
        expect(await t.call("pgsql", ["SELECT 1"])).toEqual({ echo: "pgsql" });
        const socket = FakeSocket.instances[0];
        expect(socket.url).toBe("ws://localhost/rpc");
        expect(socket.protocols).toEqual(["json"]);
        expect(socket.sent.map((m) => m.method)).toEqual(["use", "signin", "pgsql"]);
        expect(socket.sent[0].params).toEqual(["prod", "app"]);
        expect(socket.sent[1].params[0]).toMatchObject({ user: "root", pass: "root" });
    });

    it("multiplexes concurrent calls by id", async () => {
        const t = make();
        await t.open();
        const socket = FakeSocket.instances[0];
        FakeSocket.onSend = () => {};
        const a = t.call("pgsql", ["a"]);
        const b = t.call("pgsql", ["b"]);
        const before = socket.sent.length;
        await vi.waitFor(() => expect(socket.sent.length).toBe(before + 2));
        const [ma, mb] = socket.sent.slice(-2);
        socket.reply({ id: mb.id, result: "B" });
        socket.reply({ id: ma.id, result: "A" });
        expect(await Promise.all([a, b])).toEqual(["A", "B"]);
    });

    it("sends query_cancel on timeout and rejects with a timeout error", async () => {
        const t = make();
        await t.open();
        const socket = FakeSocket.instances[0];
        FakeSocket.onSend = () => {};
        const error = await t.call("pgsql", ["slow"], { timeoutMs: 10 }).catch((e) => e);
        expect(error).toBeInstanceOf(TimeoutError);
        const cancel = socket.sent.at(-1);
        expect(cancel.method).toBe("query_cancel");
        expect(cancel.params).toEqual([socket.sent.at(-2).id]);
    });

    it("fails pending calls when the socket drops, and reconnects on the next call", async () => {
        const t = make();
        await t.open();
        const first = FakeSocket.instances[0];
        FakeSocket.onSend = () => {};
        const events: string[] = [];
        t.onEvent((e) => events.push(e.type));
        const pending = t.call("pgsql", ["x"]);
        const before = first.sent.length;
        await vi.waitFor(() => expect(first.sent.length).toBe(before + 1));
        first.close();
        await expect(pending).rejects.toBeInstanceOf(ConnectionLostError);
        expect(events).toContain("disconnected");
        FakeSocket.onSend = (socket, m) =>
            socket.reply({ id: m.id, result: m.method === "signin" ? "tok" : "again" });
        expect(await t.call("pgsql", ["y"])).toBe("again");
        expect(FakeSocket.instances).toHaveLength(2);
    });

    it("routes id-less messages to live listeners", async () => {
        const t = make();
        await t.open();
        const seen: unknown[] = [];
        t.onEvent((e) => e.type === "live" && seen.push(e.message));
        FakeSocket.instances[0].reply({ result: { action: "CREATE", id: "q1", result: { a: 1 } } });
        expect(seen).toEqual([{ action: "CREATE", id: "q1", result: { a: 1 } }]);
    });
});
