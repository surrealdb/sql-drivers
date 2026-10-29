/** `SET name = 'value'` statements for the `settings` option of both dialects. */
export function settingStatements(settings: Record<string, string | number | boolean>): string[] {
    return Object.entries(settings).map(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
            throw new TypeError(`Invalid setting name "${name}"`);
        }
        return `SET ${name} = '${String(value).replaceAll("'", "''")}'`;
    });
}

/**
 * The options of the RPC `begin` method for a dialect isolation level and read-only mode.
 * SurrealDB offers snapshot and serializable isolation, as the standard allows a database to give
 * a stronger level than the one asked for: `read uncommitted`, `read committed` and
 * `repeatable read` run as snapshot.
 */
export function transactionOptions(options: {
    isolation?: string;
    readOnly?: boolean;
}): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    const level = options.isolation?.toLowerCase().trim().replace(/\s+/g, " ");
    if (level === "serializable") out.isolation = "serializable";
    else if (
        level === "snapshot" ||
        level === "repeatable read" ||
        level === "read committed" ||
        level === "read uncommitted"
    ) {
        out.isolation = "snapshot";
    } else if (level !== undefined) {
        throw new TypeError(`Unknown isolation level "${options.isolation}"`);
    }
    if (options.readOnly) out.read_only = {};
    return Object.keys(out).length > 0 ? out : undefined;
}
