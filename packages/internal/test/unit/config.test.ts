import {
    backoffDelay,
    DEFAULT_RECONNECT,
    parseConnectionString,
    resolveConfig,
} from "@surrealdb/sql-internal";
import { describe, expect, it } from "vitest";

describe("parseConnectionString", () => {
    it("reads the native form with namespace and database in the path", () => {
        const p = parseConnectionString(
            "surrealdb://root:p%40ss@abc.surrealdb.earth/prod/app",
            "pg",
        );
        expect(p).toMatchObject({
            host: "abc.surrealdb.earth",
            namespace: "prod",
            database: "app",
            username: "root",
            password: "p@ss",
        });
    });

    it("reads a postgres URL: path is the database, namespace is a parameter, port ignored", () => {
        const p = parseConnectionString("postgres://u:p@h.example:5432/app?namespace=prod", "pg");
        expect(p).toMatchObject({
            host: "h.example",
            port: "",
            database: "app",
            namespace: "prod",
        });
    });

    it("keeps the port when the scheme pins a transport", () => {
        const p = parseConnectionString("surrealdb+http://localhost:8000/t/t", "pg");
        expect(p).toMatchObject({ port: "8000", secure: false });
    });

    it("pins WebSocket for a ws suffix", () => {
        expect(parseConnectionString("surrealdb+wss://h/t/t", "pg")).toMatchObject({
            transport: "ws",
            secure: true,
        });
    });

    it("rejects the wrong dialect scheme", () => {
        expect(() => parseConnectionString("mysql://h/db", "pg")).toThrow(/Unsupported scheme/);
        expect(() => parseConnectionString("postgres://h/db", "mysql")).toThrow(
            /Unsupported scheme/,
        );
    });

    it("rejects garbage", () => {
        expect(() => parseConnectionString("not a url", "pg")).toThrow(TypeError);
        expect(() => parseConnectionString("postgres://h/db?transport=carrier", "pg")).toThrow(
            /transport/,
        );
    });
});

describe("resolveConfig", () => {
    it("uses TLS for remote hosts and plain for loopback", () => {
        expect(resolveConfig("surrealdb://abc.surrealdb.earth/a/b", "pg").httpEndpoint).toBe(
            "https://abc.surrealdb.earth",
        );
        expect(resolveConfig("surrealdb://abc.surrealdb.earth/a/b", "pg").wsEndpoint).toBe(
            "wss://abc.surrealdb.earth",
        );
        expect(resolveConfig("surrealdb+http://127.0.0.1:8000/a/b", "pg").wsEndpoint).toBe(
            "ws://127.0.0.1:8000",
        );
        expect(resolveConfig("postgres://localhost/b?ns=a", "pg").httpEndpoint).toBe(
            "http://localhost",
        );
    });

    it("takes credentials from the URL unless given", () => {
        expect(resolveConfig("postgres://root:root@localhost/b?ns=a", "pg").auth).toEqual({
            username: "root",
            password: "root",
        });
        expect(
            resolveConfig(
                { url: "postgres://root:root@localhost/b?ns=a", auth: { token: "t" } },
                "pg",
            ).auth,
        ).toEqual({ token: "t" });
    });

    it("lets options override the URL", () => {
        const c = resolveConfig(
            { url: "postgres://h/b?ns=a", database: "other", transport: "http" },
            "pg",
        );
        expect(c).toMatchObject({ database: "other", namespace: "a", transport: "http" });
    });

    it("requires a url", () => {
        expect(() => resolveConfig({}, "pg")).toThrow(/connection string/);
    });
});

describe("backoffDelay", () => {
    it("grows exponentially and is capped", () => {
        const o = { ...DEFAULT_RECONNECT, retryDelayJitter: 0 };
        expect(backoffDelay(o, 1)).toBe(2000);
        expect(backoffDelay(o, 3)).toBe(8000);
        expect(backoffDelay(o, 20)).toBe(60000);
    });
});
