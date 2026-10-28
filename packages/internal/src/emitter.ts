export type Listener = (...args: any[]) => void;

/**
 * A minimal event emitter with the subset of the Node `EventEmitter` surface which node-postgres,
 * pg-pool and mysql2 consumers rely on. It has no Node dependencies.
 */
export class Emitter {
    #listeners = new Map<string | symbol, Listener[]>();

    on(event: string | symbol, listener: Listener): this {
        const list = this.#listeners.get(event);
        if (list) list.push(listener);
        else this.#listeners.set(event, [listener]);
        return this;
    }

    addListener(event: string | symbol, listener: Listener): this {
        return this.on(event, listener);
    }

    once(event: string | symbol, listener: Listener): this {
        const wrapper: Listener = (...args) => {
            this.off(event, wrapper);
            listener(...args);
        };
        (wrapper as Listener & { listener?: Listener }).listener = listener;
        return this.on(event, wrapper);
    }

    off(event: string | symbol, listener: Listener): this {
        const list = this.#listeners.get(event);
        if (!list) return this;
        const index = list.findIndex(
            (l) =>
                l === listener || (l as Listener & { listener?: Listener }).listener === listener,
        );
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) this.#listeners.delete(event);
        return this;
    }

    removeListener(event: string | symbol, listener: Listener): this {
        return this.off(event, listener);
    }

    removeAllListeners(event?: string | symbol): this {
        if (event === undefined) this.#listeners.clear();
        else this.#listeners.delete(event);
        return this;
    }

    emit(event: string | symbol, ...args: unknown[]): boolean {
        const list = this.#listeners.get(event);
        if (!list || list.length === 0) return false;
        for (const listener of [...list]) listener(...args);
        return true;
    }

    listenerCount(event: string | symbol): number {
        return this.#listeners.get(event)?.length ?? 0;
    }
}
