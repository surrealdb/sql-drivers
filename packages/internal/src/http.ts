import { combine } from "./abort";
import { HttpAuth } from "./auth";
import type { ResolvedConfig } from "./config";
import { AbortError, AuthError, ConnectionError, UnknownResponseError } from "./errors";
import { mapRpcError } from "./rpc-error";
import type {
    CallOptions,
    RpcReply,
    Transport,
    TransportCapabilities,
    TransportEvent,
} from "./transport";

/** Stateless transport: one `POST /rpc` per call. */
export class HttpTransport implements Transport {
    readonly kind = "http" as const;
    readonly capabilities: TransportCapabilities = {
        interactiveTransactions: false,
        live: false,
        persistentSettings: false,
    };
    #config: ResolvedConfig;
    #auth: HttpAuth;
    #fetch: typeof fetch;
    #id = 0;
    #namespace: string | undefined;
    #database: string | undefined;

    constructor(config: ResolvedConfig) {
        this.#config = config;
        this.#auth = new HttpAuth(config);
        this.#fetch = config.fetch ?? ((...args) => globalThis.fetch(...args));
        this.#namespace = config.namespace;
        this.#database = config.database;
    }

    async open(): Promise<void> {}
    async close(): Promise<void> {}
    onEvent(_handler: (event: TransportEvent) => void): () => void {
        return () => {};
    }

    /** Select the namespace and database for the calls that follow. */
    use(namespace: string | undefined, database: string | undefined): void {
        this.#namespace = namespace;
        this.#database = database;
    }

    async call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T> {
        const signin = (p: Record<string, unknown>) =>
            this.#post("signin", [p], undefined, options);
        let retried = false;
        for (;;) {
            const authorization =
                method === "signin" ? undefined : await this.#auth.authorization(signin);
            try {
                return (await this.#post(method, params, authorization, options)) as T;
            } catch (error) {
                if (error instanceof AuthError && !retried && this.#config.authMode === "token") {
                    retried = true;
                    this.#auth.invalidate();
                    continue;
                }
                throw error;
            }
        }
    }

    async #post(
        method: string,
        params: unknown[],
        authorization: string | undefined,
        options: CallOptions | undefined,
    ): Promise<unknown> {
        const headers: Record<string, string> = {
            ...this.#config.headers,
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        if (this.#namespace) headers["Surreal-NS"] = this.#namespace;
        if (this.#database) headers["Surreal-DB"] = this.#database;
        if (authorization) headers.Authorization = authorization;

        const combined = combine(options?.signal, options?.timeoutMs ?? this.#config.timeout);
        let response: Response;
        try {
            response = await this.#fetch(`${this.#config.httpEndpoint}/rpc`, {
                method: "POST",
                headers,
                body: JSON.stringify({ id: ++this.#id, method, params }),
                signal: combined.signal,
                cache: "no-store",
            });
        } catch (error) {
            combined.cleanup();
            if (combined.signal?.aborted) throw combined.reason();
            if (error instanceof AbortError) throw error;
            throw new ConnectionError(`Request to ${this.#config.httpEndpoint} failed`, {
                cause: error,
            });
        }

        let text: string;
        try {
            text = await response.text();
        } catch (error) {
            if (combined.signal?.aborted) throw combined.reason();
            throw new ConnectionError("Reading the response failed", { cause: error });
        } finally {
            combined.cleanup();
        }

        const responseHeaders: Record<string, string> = {};
        response.headers?.forEach?.((value, key) => {
            responseHeaders[key] = value;
        });
        const context = { statusText: response.statusText, headers: responseHeaders };
        let reply: RpcReply;
        try {
            reply = JSON.parse(text) as RpcReply;
        } catch {
            throw new UnknownResponseError(
                `Unexpected non-JSON reply (HTTP ${response.status})`,
                response.status,
                text,
                context,
            );
        }
        if (reply === null || typeof reply !== "object" || (!reply.error && !("result" in reply))) {
            throw new UnknownResponseError(
                `Unexpected reply shape (HTTP ${response.status})`,
                response.status,
                text,
                context,
            );
        }
        if (reply.error) throw mapRpcError(reply.error, method);
        return reply.result;
    }
}
