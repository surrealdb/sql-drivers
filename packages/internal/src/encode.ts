/**
 * Encode a parameter for the JSON wire. Dates become ISO strings, bigints a number inside the
 * safe range and a decimal string beyond it, byte arrays base64 text. Anything with a
 * `toJSON` is left to `JSON.stringify`.
 */
export function encodeParam(value: unknown): unknown {
    if (value === undefined) return null;
    if (typeof value === "bigint") {
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return toBase64(value);
    if (Array.isArray(value)) return value.map(encodeParam);
    if (ArrayBuffer.isView(value)) {
        return Array.from(value as unknown as ArrayLike<number>);
    }
    return value;
}

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** Build the `_1.._n` variables object for a parameter list. */
export function buildVars(params: readonly unknown[]): Record<string, unknown> | undefined {
    if (params.length === 0) return undefined;
    const vars: Record<string, unknown> = {};
    params.forEach((p, i) => {
        vars[`_${i + 1}`] = encodeParam(p);
    });
    return vars;
}
