/**
 * A PostgreSQL wire endpoint behind a WebSocket, the shape Neon's proxy has: each WebSocket
 * connection is piped to a TCP connection of a PGlite socket server. It lets the real
 * `Pool` and `Client` of `@neondatabase/serverless` run in the conformance suites.
 */
import type { AddressInfo } from "node:net";
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { WebSocketServer } from "ws";

export interface PgWireBridge {
    /** The `host:port/path` a `wsProxy` function returns */
    proxy: string;
    close(): Promise<void>;
}

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

export async function startPgWireBridge(): Promise<PgWireBridge> {
    const db = await PGlite.create();
    const tcpPort = { port: await freePort() };
    const tcp = new PGLiteSocketServer({
        db,
        port: tcpPort.port,
        host: "127.0.0.1",
        maxConnections: 8,
    });
    await tcp.start();
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    wss.on("connection", (ws) => {
        const socket = net.connect(tcpPort.port, "127.0.0.1");
        ws.on("message", (data) => {
            const bytes = data as Buffer;
            socket.write(bytes);
            // a Terminate message ends the session; PGlite does not close the connection itself
            if (bytes.length === 5 && bytes[0] === 0x58) {
                socket.end();
                ws.close();
            }
        });
        socket.on("data", (chunk) => ws.send(chunk));
        ws.on("close", () => socket.destroy());
        socket.on("close", () => ws.close());
        socket.on("error", () => ws.close());
    });
    const wsPort = (wss.address() as AddressInfo).port;
    return {
        proxy: `127.0.0.1:${wsPort}/v1`,
        async close() {
            for (const client of wss.clients) client.terminate();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await tcp.stop();
            await db.close();
        },
    };
}
