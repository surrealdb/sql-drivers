/** A SurrealDB record id: the table and the key, written `table:key`. */
export class RecordId {
    readonly table: string;
    readonly key: string;

    constructor(table: string, key: string) {
        this.table = table;
        this.key = key;
    }

    static parse(text: string): RecordId {
        const index = text.indexOf(":");
        if (index <= 0 || index === text.length - 1) {
            throw new TypeError(`Invalid record id "${text}": expected table:key`);
        }
        return new RecordId(text.slice(0, index), text.slice(index + 1));
    }

    toString(): string {
        return `${this.table}:${this.key}`;
    }

    toJSON(): string {
        return this.toString();
    }
}

/** Build a record id from `table:key` text. */
export function recordId(text: string): RecordId {
    return RecordId.parse(text);
}
