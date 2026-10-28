import type { Credentials, ResolvedConfig, UserCredentials } from "./config";
import { AuthError } from "./errors";

export function isUser(c: Credentials): c is UserCredentials {
    return "username" in c;
}

function isToken(c: Credentials): c is { token: string } {
    return "token" in c;
}

function normalize(value: Credentials | string): Credentials {
    return typeof value === "string" ? { token: value } : value;
}

export function signinParams(c: Credentials, config: ResolvedConfig): Record<string, unknown> {
    if (isToken(c)) throw new AuthError("A token needs no signin");
    if (isUser(c)) {
        const params: Record<string, unknown> = { user: c.username, pass: c.password };
        if (c.namespace) params.ns = c.namespace;
        if (c.database) params.db = c.database;
        return params;
    }
    return {
        ...c.variables,
        ac: c.access,
        ns: c.namespace ?? config.namespace,
        db: c.database ?? config.database,
    };
}

/** The access token inside a `signin` result, which is a string or an object with `access`. */
export function tokenOf(result: unknown): { access: string; refresh?: string } {
    if (typeof result === "string") return { access: result };
    if (result && typeof result === "object" && "access" in result) {
        const r = result as { access: string; refresh?: string };
        return { access: r.access, refresh: r.refresh };
    }
    throw new AuthError("Unexpected signin result");
}

/** Seconds since the epoch at which a JWT expires, or undefined when it carries no `exp`. */
export function tokenExpiry(token: string): number | undefined {
    const part = token.split(".")[1];
    if (!part) return undefined;
    try {
        const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
        const exp = (JSON.parse(json) as { exp?: unknown }).exp;
        return typeof exp === "number" ? exp : undefined;
    } catch {
        return undefined;
    }
}

const SKEW_SECONDS = 30;

/**
 * Resolves the credential to present with each HTTP call, and keeps a signed-in token fresh
 * when `authMode` is "token". A single signin is shared by concurrent callers.
 */
export class HttpAuth {
    #config: ResolvedConfig;
    #token: { access: string; exp?: number } | undefined;
    #pending: Promise<string> | undefined;

    constructor(config: ResolvedConfig) {
        this.#config = config;
    }

    async authorization(
        signin: (params: Record<string, unknown>) => Promise<unknown>,
    ): Promise<string | undefined> {
        const raw = this.#config.auth;
        if (raw === undefined) return undefined;
        const creds = normalize(typeof raw === "function" ? await raw() : raw);
        if (isToken(creds)) return `Bearer ${creds.token}`;
        if (isUser(creds) && this.#config.authMode === "basic") {
            return `Basic ${btoa(unescape(encodeURIComponent(`${creds.username}:${creds.password}`)))}`;
        }
        return `Bearer ${await this.#signedIn(creds, signin)}`;
    }

    /** Drop the cached token so the next call signs in again. */
    invalidate(): void {
        this.#token = undefined;
    }

    async #signedIn(
        creds: Credentials,
        signin: (params: Record<string, unknown>) => Promise<unknown>,
    ): Promise<string> {
        const now = Date.now() / 1000;
        if (
            this.#token &&
            (this.#token.exp === undefined || this.#token.exp - SKEW_SECONDS > now)
        ) {
            return this.#token.access;
        }
        this.#pending ??= (async () => {
            try {
                const { access } = tokenOf(await signin(signinParams(creds, this.#config)));
                this.#token = { access, exp: tokenExpiry(access) };
                return access;
            } finally {
                this.#pending = undefined;
            }
        })();
        return this.#pending;
    }
}
