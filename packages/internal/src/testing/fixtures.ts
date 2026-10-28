/**
 * Wire fixtures copied from the examples of the engine's "Client contract". When the contract
 * changes, this file is the only place the shapes are written down for the unit tests.
 */
import type { WireResponse } from "../contract";

export const selectPersonPg: WireResponse = {
    statements: [
        {
            status: "OK",
            time: "412µs",
            command: { tag: "SELECT 1", rows_affected: 1, last_insert_id: null, warnings: 0 },
            columns: [
                {
                    name: "id",
                    type: { name: "text", oid: 25 },
                    nullable: false,
                    table: "person",
                    column: "id",
                },
                {
                    name: "name",
                    type: { name: "text", oid: 25 },
                    nullable: null,
                    table: "person",
                    column: "name",
                },
            ],
            rows: [{ id: "person:tobie", name: "Tobie" }],
        },
    ],
    transaction: { status: "idle" },
};

export const selectPersonPgArray: WireResponse = {
    ...selectPersonPg,
    statements: [{ ...selectPersonPg.statements[0], rows: [["person:tobie", "Tobie"]] }],
};

export const statementErrorPg: WireResponse = {
    statements: [
        {
            status: "ERR",
            error: {
                message: 'relation "nope" does not exist',
                severity: "ERROR",
                sqlstate: "42P01",
                errno: null,
                position: 15,
            },
        },
    ],
    transaction: { status: "idle" },
};

export const describePg: WireResponse = {
    statements: [
        {
            status: "OK",
            columns: [
                {
                    name: "name",
                    type: { name: "text", oid: 25 },
                    nullable: null,
                    table: "person",
                    column: "name",
                },
            ],
        },
    ],
    params: [{ type: { name: "text", oid: 25 } }],
    transaction: { status: "idle" },
};

export const emptyOk = (tag: string, rows = 0): WireResponse => ({
    statements: [
        {
            status: "OK",
            time: "10µs",
            command: { tag, rows_affected: rows, last_insert_id: null, warnings: 0 },
            columns: [],
            rows: [],
        },
    ],
    transaction: { status: "idle" },
});
