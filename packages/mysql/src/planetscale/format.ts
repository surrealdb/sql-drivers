/** The scanner shared by `format` and the parameter binding: calls `onPlaceholder` for each `?` or `:name` outside quotes and comments. */
function scan(
    query: string,
    onPlaceholder: (token: { kind: "positional" } | { kind: "named"; name: string }) => string,
): string {
    let out = "";
    let i = 0;
    while (i < query.length) {
        const ch = query[i];
        if (ch === "'" || ch === '"' || ch === "`") {
            let j = i + 1;
            while (j < query.length) {
                if (query[j] === "\\" && ch !== "`") j += 2;
                else if (query[j] === ch) {
                    if (query[j + 1] === ch) j += 2;
                    else break;
                } else j++;
            }
            out += query.slice(i, j + 1);
            i = j + 1;
        } else if (ch === "-" && query[i + 1] === "-") {
            const end = query.indexOf("\n", i);
            const stop = end === -1 ? query.length : end;
            out += query.slice(i, stop);
            i = stop;
        } else if (ch === "/" && query[i + 1] === "*") {
            const end = query.indexOf("*/", i + 2);
            const stop = end === -1 ? query.length : end + 2;
            out += query.slice(i, stop);
            i = stop;
        } else if (ch === "?") {
            out += onPlaceholder({ kind: "positional" });
            i++;
        } else if (
            ch === ":" &&
            /[A-Za-z_]/.test(query[i + 1] ?? "") &&
            !/[\w:]/.test(query[i - 1] ?? "")
        ) {
            let j = i + 1;
            while (j < query.length && /\w/.test(query[j])) j++;
            out += onPlaceholder({ kind: "named", name: query.slice(i + 1, j) });
            i = j;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

export type Args = unknown[] | Record<string, unknown>;

function lookup(
    args: Args,
    token: { kind: "positional" } | { kind: "named"; name: string },
    state: { next: number },
): unknown {
    if (token.kind === "positional") {
        if (!Array.isArray(args)) {
            throw new TypeError("A query with ? placeholders takes its arguments as an array");
        }
        if (state.next >= args.length) {
            throw new TypeError("The arguments are fewer than the placeholders in the query");
        }
        return args[state.next++];
    }
    if (Array.isArray(args) || !(token.name in args)) {
        throw new TypeError(`No argument was given for the placeholder :${token.name}`);
    }
    return args[token.name];
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A `Date` as a MySQL DATETIME(3) literal text, in UTC. */
export function datetimeText(date: Date): string {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

function quote(text: string): string {
    const escaped = text.replace(/[\0\n\r\\'"\x1a]/g, (c) => {
        switch (c) {
            case "\0":
                return "\\0";
            case "\n":
                return "\\n";
            case "\r":
                return "\\r";
            case "\x1a":
                return "\\Z";
            default:
                return `\\${c}`;
        }
    });
    return `'${escaped}'`;
}

function literal(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    if (typeof value === "bigint") return String(value);
    if (typeof value === "string") return quote(value);
    if (value instanceof Date) return quote(datetimeText(value));
    if (value instanceof Uint8Array) {
        return `x'${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => (Array.isArray(item) ? `(${literal(item)})` : literal(item)))
            .join(", ");
    }
    return quote(JSON.stringify(value));
}

/**
 * Render a query with its arguments as SQL text, escaping each value: `?` takes the next element
 * of an array and `:name` takes a key of an object. `execute` does not use this; it binds the
 * arguments as parameters, which is safer.
 */
export function format(query: string, values?: Args): string {
    if (values === undefined || values === null) return query;
    const state = { next: 0 };
    return scan(query, (token) => literal(lookup(values, token, state)));
}

export interface Bound {
    text: string;
    params: unknown[];
}

function bindable(value: unknown): unknown {
    if (value === undefined) return null;
    if (value instanceof Date) return datetimeText(value);
    if (
        value !== null &&
        typeof value === "object" &&
        !(value instanceof Uint8Array) &&
        !ArrayBuffer.isView(value)
    ) {
        return JSON.stringify(value);
    }
    return value;
}

/**
 * Turn `?` and `:name` placeholders into positional `?` markers and the parameters they bind.
 * An array argument expands to one marker per element, an empty one to `NULL`.
 */
export function bind(query: string, args?: Args): Bound {
    const params: unknown[] = [];
    if (args === undefined || args === null) return { text: query, params };
    const state = { next: 0 };
    const text = scan(query, (token) => {
        const value = lookup(args, token, state);
        if (Array.isArray(value)) {
            if (value.length === 0) return "NULL";
            for (const item of value) params.push(bindable(item));
            return value.map(() => "?").join(", ");
        }
        params.push(bindable(value));
        return "?";
    });
    return { text, params };
}
