import {
    AuthError,
    CapabilityDeniedError,
    HttpTransport,
    RpcError,
    resolveConfig,
    TimeoutError,
    UnknownResponseError,
} from "@surrealdb/sql-internal";
import { describe, expect, it } from "vitest";

function transport(handler: (req: Request) => Response | Promise<Response>, extra = {}) {
    const requests: { url: string; headers: Headers; body: any }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const req = new Request(url, init);
        requests.push({ url, headers: req.headers, body: JSON.parse(String(init.body)) });
        return handler(req);
    }) as unknown as typeof fetch;
    const config = resolveConfig(
        { url: "postgres://root:root@localhost/app?ns=prod", fetch: fetchImpl, ...extra },
        "pg",
    );
    return { t: new HttpTransport(config), requests };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("HttpTransport", () => {
    it("posts to /rpc with Basic auth, namespace and database headers", async () => {
        const { t, requests } = transport(() => json({ id: 1, result: { ok: true } }));
        expect(await t.call("pgsql", ["SELECT 1"])).toEqual({ ok: true });
        const [r] = requests;
        expect(r.url).toBe("http://localhost/rpc");
        expect(r.headers.get("authorization")).toBe(`Basic ${btoa("root:root")}`);
        expect(r.headers.get("surreal-ns")).toBe("prod");
        expect(r.headers.get("surreal-db")).toBe("app");
        expect(r.body).toMatchObject({ method: "pgsql", params: ["SELECT 1"] });
    });

    it("signs in once in token mode and shares the token", async () => {
        const { t, requests } = transport(
            (req) =>
                req.headers.get("authorization")
                    ? json({ id: 1, result: 1 })
                    : json({ id: 1, result: "tok" }),
            { authMode: "token" },
        );
        await Promise.all([t.call("pgsql", ["a"]), t.call("pgsql", ["b"])]);
        expect(requests.filter((r) => r.body.method === "signin")).toHaveLength(1);
        expect(
            requests
                .filter((r) => r.body.method === "pgsql")
                .every((r) => r.headers.get("authorization") === "Bearer tok"),
        ).toBe(true);
    });

    it("retries once with a fresh sign-in after an auth failure, then gives up", async () => {
        let queries = 0;
        const { t, requests } = transport(
            (req) => {
                const method = JSON.parse(
                    String(
                        requests[requests.length - 1] &&
                            JSON.stringify(requests[requests.length - 1].body),
                    ),
                ).method;
                void req;
                if (method === "signin") return json({ id: 1, result: "tok" });
                queries++;
                return json({
                    id: 1,
                    error: { code: -32002, kind: "Auth", message: "invalid token" },
                });
            },
            { authMode: "token" },
        );
        await expect(t.call("pgsql", ["a"])).rejects.toBeInstanceOf(AuthError);
        expect(queries).toBe(2);
        expect(requests.filter((r) => r.body.method === "signin")).toHaveLength(2);
    });

    it("maps NotAllowed to a capability error and method-not-found to an actionable RpcError", async () => {
        const denied = transport(() =>
            json({
                id: 1,
                error: {
                    code: -32002,
                    kind: "NotAllowed",
                    message: "Method not allowed: pgsql",
                    details: { kind: "Method" },
                },
            }),
        );
        await expect(denied.t.call("pgsql", ["x"])).rejects.toBeInstanceOf(CapabilityDeniedError);
        const missing = transport(() =>
            json({ id: 1, error: { code: -32601, kind: "NotFound", message: "Method not found" } }),
        );
        await expect(missing.t.call("pgsql", ["x"])).rejects.toThrow(/predate the SQL RPC methods/);
        await expect(missing.t.call("pgsql", ["x"])).rejects.toBeInstanceOf(RpcError);
    });

    it("reports a non-JSON reply as an unknown response with a truncated body", async () => {
        const { t } = transport(() => new Response("x".repeat(10000), { status: 502 }));
        const error: any = await t.call("pgsql", ["x"]).catch((e) => e);
        expect(error).toBeInstanceOf(UnknownResponseError);
        expect(error.status).toBe(502);
        expect(error.body).toHaveLength(4096);
    });

    it("times out", async () => {
        const { t } = transport(
            (req) =>
                new Promise<Response>((_, reject) =>
                    req.signal.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    ),
                ),
            { timeout: 20 },
        );
        await expect(t.call("pgsql", ["x"])).rejects.toBeInstanceOf(TimeoutError);
    });

    it("never offers a session", () => {
        const { t } = transport(() => json({ id: 1, result: 1 }));
        expect(t.capabilities).toEqual({
            interactiveTransactions: false,
            live: false,
            persistentSettings: false,
        });
    });
});
