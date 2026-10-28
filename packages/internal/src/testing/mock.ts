import type { CallOptions, Transport, TransportCapabilities, TransportEvent } from "../transport";

export interface RecordedCall {
    method: string;
    params: unknown[];
    options: CallOptions | undefined;
}

export type MockHandler = (
    method: string,
    params: unknown[],
    options: CallOptions | undefined,
) => unknown | Promise<unknown>;

/** A transport which answers calls from a handler and records them. */
export class MockTransport implements Transport {
    readonly kind: "http" | "ws";
    readonly capabilities: TransportCapabilities;
    readonly calls: RecordedCall[] = [];
    #handlers = new Set<(event: TransportEvent) => void>();
    opened = 0;
    closed = 0;

    constructor(
        public handler: MockHandler,
        kind: "http" | "ws" = "ws",
    ) {
        this.kind = kind;
        const ws = kind === "ws";
        this.capabilities = {
            interactiveTransactions: ws,
            live: ws,
            persistentSettings: ws,
        };
    }

    async call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T> {
        this.calls.push({ method, params, options });
        return (await this.handler(method, params, options)) as T;
    }

    async open(): Promise<void> {
        this.opened++;
    }

    async close(): Promise<void> {
        this.closed++;
    }

    onEvent(handler: (event: TransportEvent) => void): () => void {
        this.#handlers.add(handler);
        return () => this.#handlers.delete(handler);
    }

    emit(event: TransportEvent): void {
        for (const h of [...this.#handlers]) h(event);
    }
}
