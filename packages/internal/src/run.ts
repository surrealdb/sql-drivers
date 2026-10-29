import type {
    BatchEntry,
    SqlCallOptions,
    SqlMethod,
    TransactionStatus,
    WireResponse,
    WireStatement,
} from "./contract";
import { RpcError, StatementError, UnsupportedOnTransportError } from "./errors";
import type { CallOptions, Transport } from "./transport";

export function toStatementError(statement: WireStatement): StatementError {
    const e = statement.error ?? { message: "Unknown statement error" };
    return new StatementError(e);
}

/**
 * One SQL session over a transport: sends `pgsql` or `mysql` calls, applies the settings the
 * dialect needs, and follows the transaction status the instance reports.
 *
 * Over a transport which keeps settings (WebSocket) the setting statements run once per
 * connection. Over one which does not (HTTP) they are prepended to every call, and their
 * results are removed from the response so that result indexes line up with the caller's
 * statements.
 */
export class SqlSession {
    status: TransactionStatus = "idle";
    #settingsApplied = false;
    #applying: Promise<void> | undefined;
    #unsubscribe: () => void;

    constructor(
        readonly transport: Transport,
        readonly method: SqlMethod,
        readonly settings: readonly string[] = [],
    ) {
        this.#unsubscribe = transport.onEvent((event) => {
            if (event.type === "disconnected") {
                this.#settingsApplied = false;
                this.status = "idle";
            }
        });
    }

    dispose(): void {
        this.#unsubscribe();
    }

    /** Send one call. Statement errors stay in the response; only call-level failures throw. */
    async run(
        statements: string | readonly (string | BatchEntry)[],
        vars?: Record<string, unknown>,
        options?: SqlCallOptions,
        call?: CallOptions,
    ): Promise<WireResponse> {
        const persistent = this.transport.capabilities.persistentSettings;
        if (this.settings.length > 0 && persistent && !this.#settingsApplied) {
            this.#applying ??= this.#applySettings(call).finally(() => {
                this.#applying = undefined;
            });
            await this.#applying;
        }
        const prefix = !persistent ? this.settings.length : 0;
        if (prefix > 0 && options?.atomic) {
            throw new UnsupportedOnTransportError(
                "Session settings cannot be combined with an atomic call over HTTP, because an atomic call refuses SET statements and HTTP keeps settings for the request only; use a WebSocket or drop the settings",
            );
        }
        let body: string | readonly (string | BatchEntry)[] = statements;
        if (prefix > 0) {
            body = [
                ...this.settings,
                ...(typeof statements === "string" ? [statements] : statements),
            ];
        }
        const response = await this.#send(body, vars, options, call);
        if (prefix > 0) {
            const head = response.statements.slice(0, prefix);
            const failed = head.find((s) => s.status === "ERR");
            if (failed) {
                const error = toStatementError(failed);
                error.message = `A session setting failed: ${error.message}`;
                throw error;
            }
            response.statements = response.statements.slice(prefix);
        }
        return response;
    }

    async #applySettings(call: CallOptions | undefined): Promise<void> {
        const response = await this.#send([...this.settings], undefined, undefined, call);
        const failed = response.statements.find((s) => s.status === "ERR");
        if (failed) {
            const error = toStatementError(failed);
            error.message = `A session setting failed: ${error.message}`;
            throw error;
        }
        this.#settingsApplied = true;
    }

    async #send(
        statements: string | readonly (string | BatchEntry)[],
        vars: Record<string, unknown> | undefined,
        options: SqlCallOptions | undefined,
        call: CallOptions | undefined,
    ): Promise<WireResponse> {
        const params: unknown[] = [statements];
        const hasOptions = options && Object.keys(options).length > 0;
        if (vars || hasOptions) params.push(vars ?? null);
        if (hasOptions) params.push(options);
        const response = await this.transport.call<WireResponse>(this.method, params, call);
        if (!response || !Array.isArray(response.statements)) {
            throw new RpcError(`Unexpected ${this.method} response shape`, -32603);
        }
        if (response.transaction) this.status = response.transaction.status;
        return response;
    }
}
