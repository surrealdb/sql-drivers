import { combine } from "./abort";
import { isUser, signinParams, tokenExpiry, tokenOf } from "./auth";
import { backoffDelay, type Credentials, type ResolvedConfig } from "./config";
import { ConnectionError, ConnectionLostError } from "./errors";
import { mapRpcError } from "./rpc-error";
import type {
    CallOptions,
    RpcReply,
    Transport,
    TransportCapabilities,
    TransportEvent,
} from "./transport";

interface Pending {
    method: string;
    resolve(value: unknown): void;
    reject(error: unknown): void;
}

const SKEW_SECONDS = 30;

/** Session transport: one WebSocket, calls multiplexed by id, with live notifications. */
export class WsTransport implements Transport {
    readonly kind = "ws" as const;
    readonly capabilities: TransportCapabilities = {
        interactiveTransactions: true,
        live: true,
        persistentSettings: true,
    };
    #config: ResolvedConfig;
    #socket: WebSocket | undefined;
    #opening: Promise<void> | undefined;
    #pending = new Map<number, Pending>();
    #handlers = new Set<(event: TransportEvent) => void>();
    #id = 0;
    #everOpened = false;
    #closedByUser = false;
    #credentials: Credentials | undefined;
    #expiry: number | undefined;
    #namespace: string | undefined;
    #database: string | undefined;

    constructor(config: ResolvedConfig) {
        this.#config = config;
        this.#namespace = config.namespace;
        this.#database = config.database;
    }

    onEvent(handler: (event: TransportEvent) => void): () => void {
        this.#handlers.add(handler);
        return () => this.#handlers.delete(handler);
    }

    #emit(event: TransportEvent): void {
        for (const handler of [...this.#handlers]) handler(event);
    }

    open(): Promise<void> {
        if (this.#socket && this.#socket.readyState === 1) return Promise.resolve();
        this.#closedByUser = false;
        this.#opening ??= this.#connect().finally(() => {
            this.#opening = undefined;
        });
        return this.#opening;
    }

    async close(): Promise<void> {
        this.#closedByUser = true;
        const socket = this.#socket;
        this.#socket = undefined;
        socket?.close();
        this.#failAll(new ConnectionLostError("Connection closed"));
    }

    async #connect(): Promise<void> {
        const retries =
            this.#everOpened && this.#config.reconnect.enabled
                ? this.#config.reconnect.attempts
                : 0;
        let lastError: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) {
                await new Promise((r) =>
                    setTimeout(r, backoffDelay(this.#config.reconnect, attempt)),
                );
            }
            try {
                await this.#openSocket();
                await this.#establishSession();
                this.#everOpened = true;
                this.#emit({ type: "connected" });
                return;
            } catch (error) {
                lastError = error;
                this.#socket?.close();
                this.#socket = undefined;
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new ConnectionError("Connecting failed", { cause: lastError });
    }

    #openSocket(): Promise<void> {
        const Ctor = this.#config.WebSocket ?? (globalThis as { WebSocket?: unknown }).WebSocket;
        if (!Ctor)
            throw new ConnectionError(
                "No WebSocket implementation: pass `WebSocket` in the options",
            );
        return new Promise<void>((resolve, reject) => {
            const socket = new (Ctor as new (u: string, p?: string[]) => WebSocket)(
                `${this.#config.wsEndpoint}/rpc`,
                ["json"],
            );
            this.#socket = socket;
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
                "error",
                (e) =>
                    reject(
                        new ConnectionError(`WebSocket to ${this.#config.wsEndpoint} failed`, {
                            cause: e,
                        }),
                    ),
                { once: true },
            );
            socket.addEventListener("message", (e) => this.#onMessage(e.data));
            socket.addEventListener("close", () => this.#onClose(socket));
        });
    }

    async #establishSession(): Promise<void> {
        if (this.#namespace || this.#database) {
            await this.#send("use", [this.#namespace ?? null, this.#database ?? null], undefined);
        }
        await this.#authenticate();
    }

    async #authenticate(): Promise<void> {
        const raw = this.#config.auth;
        if (raw === undefined) return;
        const value = typeof raw === "function" ? await raw() : raw;
        const creds: Credentials = typeof value === "string" ? { token: value } : value;
        this.#credentials = creds;
        if ("token" in creds) {
            await this.#send("authenticate", [creds.token], undefined);
            this.#expiry = tokenExpiry(creds.token);
            return;
        }
        const { access } = tokenOf(
            await this.#send("signin", [signinParams(creds, this.#config)], undefined),
        );
        this.#expiry = tokenExpiry(access);
    }

    /** Re-establish credentials before a call when the access token is about to expire. */
    async #ensureFresh(): Promise<void> {
        if (this.#expiry === undefined) return;
        if (this.#expiry - SKEW_SECONDS > Date.now() / 1000) return;
        const creds = this.#credentials;
        if (creds && (isUser(creds) || "access" in creds)) await this.#authenticate();
    }

    #onMessage(data: unknown): void {
        let text: string;
        if (typeof data === "string") text = data;
        else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
        else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
        else return;
        let reply: RpcReply;
        try {
            reply = JSON.parse(text) as RpcReply;
        } catch {
            return;
        }
        if (reply.id !== undefined && reply.id !== null) {
            const pending = this.#pending.get(Number(reply.id));
            if (!pending) return;
            this.#pending.delete(Number(reply.id));
            if (reply.error) pending.reject(mapRpcError(reply.error, pending.method));
            else pending.resolve(reply.result);
            return;
        }
        this.#emit({ type: "live", message: reply.result });
    }

    #onClose(socket: WebSocket): void {
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        const error = new ConnectionLostError("The WebSocket closed");
        this.#failAll(error);
        if (!this.#closedByUser) this.#emit({ type: "disconnected", error });
    }

    #failAll(error: Error): void {
        for (const [id, pending] of this.#pending) {
            this.#pending.delete(id);
            pending.reject(error);
        }
    }

    #send(method: string, params: unknown[], options: CallOptions | undefined): Promise<unknown> {
        const socket = this.#socket;
        if (socket?.readyState !== 1) {
            return Promise.reject(new ConnectionLostError("The WebSocket is not open"));
        }
        const id = ++this.#id;
        const combined = combine(options?.signal, options?.timeoutMs ?? this.#config.timeout);
        return new Promise<unknown>((resolve, reject) => {
            const done = () => combined.cleanup();
            this.#pending.set(id, {
                method,
                resolve: (v) => {
                    done();
                    resolve(v);
                },
                reject: (e) => {
                    done();
                    reject(e);
                },
            });
            combined.signal?.addEventListener(
                "abort",
                () => {
                    if (!this.#pending.delete(id)) return;
                    this.#socket?.send(
                        JSON.stringify({ id: ++this.#id, method: "query_cancel", params: [id] }),
                    );
                    done();
                    reject(combined.reason());
                },
                { once: true },
            );
            const message: Record<string, unknown> = { id, method, params };
            if (options?.txn) message.txn = options.txn;
            try {
                socket.send(JSON.stringify(message));
            } catch (error) {
                this.#pending.delete(id);
                done();
                reject(new ConnectionLostError("Sending failed", false, { cause: error }));
            }
        });
    }

    async call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T> {
        await this.open();
        if (method !== "signin" && method !== "authenticate") await this.#ensureFresh();
        if (method === "use" && params.length >= 2) {
            this.#namespace = (params[0] as string | null) ?? undefined;
            this.#database = (params[1] as string | null) ?? undefined;
        }
        return (await this.#send(method, params, options)) as T;
    }
}
