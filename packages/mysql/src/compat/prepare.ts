/** Quote an identifier the way mysql2 does: backticks, with dots separating parts. */
export function escapeId(value: unknown): string {
    if (Array.isArray(value)) return value.map(escapeId).join(", ");
    return `\`${String(value).replaceAll("`", "``").replaceAll(".", "`.`")}\``;
}

/**
 * Prepare statement text and values for the wire. `?` placeholders bind server-side. For
 * `query` (`expand` true), mysql2's conveniences are kept: `??` takes an identifier, an array
 * expands to a list and an array of arrays to a list of lists. Nothing is interpolated into the
 * text except identifiers, which are quoted.
 */
export function prepare(
    sql: string,
    values: readonly unknown[] | undefined,
    expand: boolean,
): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    if (!values || values.length === 0) return { text: sql, params };
    let text = "";
    let index = 0;
    let i = 0;
    const flatten = (value: unknown): string => {
        if (Array.isArray(value) && expand) {
            return value
                .map((item) => (Array.isArray(item) ? `(${flatten(item)})` : flatten(item)))
                .join(", ");
        }
        params.push(value);
        return "?";
    };
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === "'" || ch === '"' || ch === "`") {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "\\" && ch !== "`") j += 2;
                else if (sql[j] === ch) {
                    if (sql[j + 1] === ch) j += 2;
                    else break;
                } else j++;
            }
            text += sql.slice(i, j + 1);
            i = j + 1;
        } else if (ch === "-" && sql[i + 1] === "-") {
            const end = sql.indexOf("\n", i);
            const stop = end === -1 ? sql.length : end;
            text += sql.slice(i, stop);
            i = stop;
        } else if (ch === "/" && sql[i + 1] === "*") {
            const end = sql.indexOf("*/", i + 2);
            const stop = end === -1 ? sql.length : end + 2;
            text += sql.slice(i, stop);
            i = stop;
        } else if (ch === "?") {
            const identifier = sql[i + 1] === "?";
            i += identifier ? 2 : 1;
            if (index >= values.length) {
                throw new TypeError(
                    "Bind parameters are fewer than the placeholders in the statement",
                );
            }
            const value = values[index++];
            text += identifier ? escapeId(value) : flatten(value === undefined ? null : value);
        } else {
            text += ch;
            i++;
        }
    }
    return { text, params };
}
