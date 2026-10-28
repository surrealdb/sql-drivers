import { StatementError } from "@surrealdb/sql-internal";

/** The error shape node-postgres raises for a server-side failure. */
export class DatabaseError extends Error {
    override name = "DatabaseError";
    severity: string | undefined;
    code: string | undefined;
    detail: string | undefined;
    hint: string | undefined;
    position: string | undefined;
    internalPosition: string | undefined;
    internalQuery: string | undefined;
    where: string | undefined;
    schema: string | undefined;
    table: string | undefined;
    column: string | undefined;
    dataType: string | undefined;
    constraint: string | undefined;
    file: string | undefined;
    line: string | undefined;
    routine: string | undefined;

    constructor(message: string, severity?: string, code?: string) {
        super(message);
        this.severity = severity;
        this.code = code;
    }

    static from(error: StatementError): DatabaseError {
        const e = new DatabaseError(error.message, error.severity, error.sqlstate ?? undefined);
        if (error.position !== null) e.position = String(error.position);
        return e;
    }
}
