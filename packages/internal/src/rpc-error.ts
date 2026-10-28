import { AuthError, CapabilityDeniedError, RpcError } from "./errors";
import type { RpcErrorBody } from "./transport";

/** Map the `error` of an RPC reply to the error a caller sees. */
export function mapRpcError(body: RpcErrorBody, method: string): Error {
    const message = body.message ?? "RPC error";
    const code = body.code ?? -32000;
    const details = body.details as { kind?: string } | undefined;
    if (code === -32601) {
        return new RpcError(
            `${message}: the instance does not serve the "${method}" method; it may predate the SQL RPC methods`,
            code,
            body.kind,
            body.details,
        );
    }
    if (body.kind === "NotAllowed") {
        if (details?.kind === "Auth" || /anonymous|not enough permissions/i.test(message)) {
            return new AuthError(message);
        }
        return new CapabilityDeniedError(message);
    }
    if (body.kind === "Auth" || /invalid (auth|token)|token has expired/i.test(message)) {
        return new AuthError(message);
    }
    return new RpcError(message, code, body.kind, body.details);
}
