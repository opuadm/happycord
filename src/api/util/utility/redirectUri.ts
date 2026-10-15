/* SPDX-License-Identifier: AGPL-3.0-only */
const BLOCKED_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "filesystem:"]);

export const isAllowedRedirectUri = (uri: unknown) => {
    if (typeof uri !== "string" || !uri || uri.length > 2048 || [...uri].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)) return false;
    try {
        const { protocol } = new URL(uri);
        return /^[a-z][a-z0-9+.-]*:$/.test(protocol) && !BLOCKED_REDIRECT_SCHEMES.has(protocol);
    } catch {
        return false;
    }
};
