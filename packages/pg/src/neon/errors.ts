import type { StatementError } from "@surrealdb/sql-internal";
import { DatabaseError } from "../compat/errors";

/** The error raised by `neon()` calls: a `DatabaseError` with the same fields, named `NeonDbError`. */
export class NeonDbError extends DatabaseError {
    override name = "NeonDbError";
    /** The underlying error, when this one wraps another */
    sourceError: Error | undefined;

    static override from(error: StatementError): NeonDbError {
        const e = new NeonDbError(error.message, error.severity, error.sqlstate ?? undefined);
        if (error.position !== null) e.position = String(error.position);
        e.sourceError = error;
        return e;
    }
}
