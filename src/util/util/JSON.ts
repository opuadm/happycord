// Discord.com sends ISO strings with +00:00 extension, not Z
// This causes issues with Python bot libs

export function JSONReplacer(this: { [key: string]: unknown }, key: string, value: unknown) {
    const original: unknown = this[key];
    if (original instanceof Date) {
        return Number.isNaN(original.getTime()) ? null : original.toISOString().replace("Z", "+00:00");
    }

    // erlpack encoding doesn't call json.stringify,
    // so our toJSON functions don't get called.
    // manually call it here
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-expect-error
    if (this?.[key]?.toJSON)
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-expect-error
        this[key] = this[key].toJSON();

    return value;
}

function discordDateReplacer(this: { [key: string]: unknown }, key: string, value: unknown) {
    const original: unknown = this[key];
    if (original instanceof Date) return Number.isNaN(original.getTime()) ? null : original.toISOString().replace("Z", "+00:00");
    return value;
}

export function JSONStringify(value: unknown) {
    return JSON.stringify(value, discordDateReplacer as (this: object, key: string, value: unknown) => unknown);
}
