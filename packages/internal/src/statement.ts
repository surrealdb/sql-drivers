/** Text spliced into a statement verbatim. Only ever built from trusted text. */
export class Raw {
    constructor(readonly text: string) {}
}

export type StatementValue = unknown;

interface Template {
    kind: "template";
    strings: readonly string[];
    values: readonly StatementValue[];
}

interface Direct {
    kind: "direct";
    text: string;
    params: readonly unknown[];
}

/**
 * A statement which has not run. It is a thenable: it runs when awaited, and a batch collects
 * the statements it is given without running them.
 */
export class Statement<T = unknown> implements PromiseLike<T> {
    readonly source: Template | Direct;
    #run: (statement: Statement<T>) => Promise<T>;
    #promise: Promise<T> | undefined;

    constructor(source: Template | Direct, run: (statement: Statement<T>) => Promise<T>) {
        this.source = source;
        this.#run = run;
    }

    static template<T>(
        strings: readonly string[],
        values: readonly StatementValue[],
        run: (statement: Statement<T>) => Promise<T>,
    ): Statement<T> {
        return new Statement<T>({ kind: "template", strings, values }, run);
    }

    static direct<T>(
        text: string,
        params: readonly unknown[],
        run: (statement: Statement<T>) => Promise<T>,
    ): Statement<T> {
        return new Statement<T>({ kind: "direct", text, params }, run);
    }

    then<R1 = T, R2 = never>(
        onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
        onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
        this.#promise ??= this.#run(this);
        return this.#promise.then(onfulfilled, onrejected);
    }

    catch<R = never>(
        onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
    ): Promise<T | R> {
        return this.then(undefined, onrejected);
    }

    finally(onfinally?: (() => void) | null): Promise<T> {
        return this.then(
            (v) => (onfinally?.(), v),
            (e) => {
                onfinally?.();
                throw e;
            },
        );
    }
}

export interface Rendered {
    text: string;
    params: unknown[];
}

/**
 * Render a statement to text with positional placeholders and the parameters they bind.
 * Nested template statements and `Raw` values are inlined and share one placeholder counter.
 * A nested statement built with `query(text, params)` cannot be inlined, since its placeholders
 * are already numbered.
 */
export function render(
    // biome-ignore lint/suspicious/noExplicitAny: a statement of any result type renders the same
    statement: Statement<any>,
    placeholder: (index: number) => string,
): Rendered {
    const params: unknown[] = [];
    const walk = (source: Statement["source"], nested: boolean): string => {
        if (source.kind === "direct") {
            if (nested) {
                throw new TypeError(
                    "A statement built with query(text, params) cannot be nested in a template",
                );
            }
            params.push(...source.params);
            return source.text;
        }
        let text = source.strings[0] ?? "";
        source.values.forEach((value, i) => {
            if (value instanceof Raw) text += value.text;
            else if (value instanceof Statement) text += walk(value.source, true);
            else {
                params.push(value);
                text += placeholder(params.length);
            }
            text += source.strings[i + 1] ?? "";
        });
        return text;
    };
    return { text: walk(statement.source, false), params };
}
