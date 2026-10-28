/** A WebSocket stand-in which answers messages from a script, for tests. */
export type SocketScript = (
    socket: FakeSocket,
    message: { id: number; method: string; params: unknown[]; [key: string]: unknown },
) => void;

export class FakeSocket extends EventTarget {
    static instances: FakeSocket[] = [];
    static script: SocketScript = () => {};
    readyState = 0;
    sent: { id: number; method: string; params: unknown[]; [key: string]: unknown }[] = [];

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

    static reset(script: SocketScript): void {
        FakeSocket.instances = [];
        FakeSocket.script = script;
    }

    send(data: string): void {
        const message = JSON.parse(data);
        this.sent.push(message);
        FakeSocket.script(this, message);
    }

    reply(message: unknown): void {
        this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
    }

    close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
    }
}

/** The usual script: signin returns a token, everything else is answered by `answer`. */
export function answering(answer: (method: string, params: unknown[]) => unknown): SocketScript {
    return (socket, m) => {
        if (m.method === "signin") socket.reply({ id: m.id, result: "tok" });
        else if (m.method === "use" || m.method === "authenticate")
            socket.reply({ id: m.id, result: null });
        else socket.reply({ id: m.id, result: answer(m.method, m.params) });
    };
}

/** A script which routes `pgsql` and the session methods to a handler which may be async. */
export function routing(
    handle: (method: string, params: unknown[]) => Promise<unknown>,
): SocketScript {
    return (socket, m) => {
        handle(m.method, m.params).then(
            (result) => socket.reply({ id: m.id, result }),
            (error) => socket.reply({ id: m.id, error }),
        );
    };
}
