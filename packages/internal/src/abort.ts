import { AbortError, TimeoutError } from "./errors";

export interface Combined {
    signal: AbortSignal | undefined;
    /** The error to throw once `signal` has aborted */
    reason(): Error;
    cleanup(): void;
}

/** Combine a caller signal and a timeout into one signal. */
export function combine(signal: AbortSignal | undefined, timeoutMs: number | undefined): Combined {
    if (!signal && !timeoutMs) {
        return { signal: undefined, reason: () => new AbortError("Aborted"), cleanup() {} };
    }
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs) {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
    }
    return {
        signal: controller.signal,
        reason: () =>
            timedOut
                ? new TimeoutError(`Request timed out after ${timeoutMs}ms`)
                : new AbortError("Aborted"),
        cleanup() {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        },
    };
}
