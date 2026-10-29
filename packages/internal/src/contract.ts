/** Wire shapes of the `pgsql` and `mysql` RPC methods. See the engine's "Client contract". */

export interface WireType {
    name?: string;
    oid?: number;
    element?: WireType;
    mysql_type?: number;
}

export interface WireColumn {
    name: string;
    type: WireType;
    nullable: boolean | null;
    table: string | null;
    column: string | null;
}

export interface WireCommand {
    tag: string;
    rows_affected: number | null;
    last_insert_id: number | string | null;
    warnings: number;
}

export interface WireError {
    message: string;
    severity?: string | null;
    sqlstate?: string | null;
    errno?: number | null;
    position?: number | null;
}

export interface WireStatement {
    status: "OK" | "ERR";
    time?: string;
    command?: WireCommand;
    columns?: WireColumn[];
    rows?: unknown[];
    error?: WireError;
}

export type TransactionStatus = "idle" | "active" | "failed";

export interface WireResponse {
    statements: WireStatement[];
    params?: { type: WireType }[];
    transaction: { status: TransactionStatus; id?: string; committed?: boolean };
}

export interface SqlCallOptions {
    describe?: boolean;
    rowMode?: "object" | "array";
    valueMode?: "native" | "text";
    atomic?: boolean;
}

export type SqlMethod = "pgsql" | "mysql";

export interface BatchEntry {
    text: string;
    vars?: Record<string, unknown>;
}
