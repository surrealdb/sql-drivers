/** `SET name = 'value'` statements for the `settings` option of both dialects. */
export function settingStatements(settings: Record<string, string | number | boolean>): string[] {
    return Object.entries(settings).map(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
            throw new TypeError(`Invalid setting name "${name}"`);
        }
        return `SET ${name} = '${String(value).replaceAll("'", "''")}'`;
    });
}
