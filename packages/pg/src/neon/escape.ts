/** Quote an identifier: double quotes, with embedded double quotes doubled. */
export function escapeIdentifier(value: string): string {
    return `"${String(value).replaceAll('"', '""')}"`;
}

/** Quote a literal: single quotes doubled, and the `E` form when the text has backslashes. */
export function escapeLiteral(value: string): string {
    const text = String(value);
    const escaped = text.replaceAll("'", "''");
    return text.includes("\\") ? ` E'${escaped.replaceAll("\\", "\\\\")}'` : `'${escaped}'`;
}
