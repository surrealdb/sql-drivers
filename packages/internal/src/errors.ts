/** The root of every error these packages throw. */
export class SurrealSqlError extends Error {
    override name = "SurrealSqlError";
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
    }
}

export class ConnectionError extends SurrealSqlError {
    override name = "ConnectionError";
}

/** The connection dropped. `inTransaction` is true when an open transaction was lost with it. */
export class ConnectionLostError extends ConnectionError {
    override name = "ConnectionLostError";
    inTransaction: boolean;
    constructor(message: string, inTransaction = false, options?: { cause?: unknown }) {
        super(message, options);
        this.inTransaction = inTransaction;
    }
}

export class AuthError extends SurrealSqlError {
    override name = "AuthError";
}

/** The instance refused the method or the dialect route capability. */
export class CapabilityDeniedError extends SurrealSqlError {
    override name = "CapabilityDeniedError";
}

/** A failure of the call itself rather than of a statement. */
export class RpcError extends SurrealSqlError {
    override name = "RpcError";
    code: number;
    kind: string | undefined;
    details: unknown;
    constructor(message: string, code: number, kind?: string, details?: unknown) {
        super(message);
        this.code = code;
        this.kind = kind;
        this.details = details;
    }
}

export interface StatementErrorFields {
    message: string;
    severity?: string | null;
    sqlstate?: string | null;
    errno?: number | null;
    position?: number | null;
}

/** A statement failed. The call itself succeeded. */
export class StatementError extends SurrealSqlError {
    override name = "StatementError";
    severity: string;
    sqlstate: string | null;
    errno: number | null;
    position: number | null;
    /** Results of the statements of the call, set when the call had several */
    results: unknown[] | undefined;
    constructor(fields: StatementErrorFields) {
        super(fields.message);
        this.severity = fields.severity ?? "ERROR";
        this.sqlstate = fields.sqlstate ?? null;
        this.errno = fields.errno ?? null;
        this.position = fields.position ?? null;
    }
}

export class AbortError extends SurrealSqlError {
    override name = "AbortError";
}

export class TimeoutError extends SurrealSqlError {
    override name = "TimeoutError";
}

/** The reply was not an RPC reply, as when a proxy answers in place of the instance. */
export class UnknownResponseError extends SurrealSqlError {
    override name = "UnknownResponseError";
    status: number;
    statusText: string;
    body: string;
    headers: Record<string, string>;
    constructor(
        message: string,
        status: number,
        body: string,
        context: { statusText?: string; headers?: Record<string, string> } = {},
    ) {
        super(message);
        this.status = status;
        this.statusText = context.statusText ?? "";
        this.body = body.slice(0, 4096);
        this.headers = context.headers ?? {};
    }
}

/** A transaction or live query was requested on a transport which cannot hold a session. */
export class UnsupportedOnTransportError extends SurrealSqlError {
    override name = "UnsupportedOnTransportError";
}
