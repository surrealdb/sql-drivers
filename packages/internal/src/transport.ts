export interface CallOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Transaction opened with `begin`, as for `query`; WebSocket only */
    txn?: string;
}

export type TransportEvent =
    | { type: "live"; message: unknown }
    | { type: "disconnected"; error?: unknown }
    | { type: "connected" };

export interface TransportCapabilities {
    interactiveTransactions: boolean;
    live: boolean;
    persistentSettings: boolean;
}

/**
 * One RPC endpoint. Everything above the transport speaks this interface, so unit tests run
 * against a mock and the HTTP and WebSocket implementations are interchangeable.
 */
export interface Transport {
    readonly kind: "http" | "ws";
    readonly capabilities: TransportCapabilities;
    /** Issue one RPC call and resolve its `result`, or throw the mapped error. */
    call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T>;
    open(): Promise<void>;
    close(): Promise<void>;
    onEvent(handler: (event: TransportEvent) => void): () => void;
}

export interface RpcErrorBody {
    code?: number;
    kind?: string;
    message?: string;
    details?: unknown;
}

export interface RpcReply {
    id?: number | string | null;
    result?: unknown;
    error?: RpcErrorBody;
}
