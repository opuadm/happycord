/* SPDX-License-Identifier: AGPL-3.0-only */

export interface AutomodAppealSchema {
    login: string;
    /**
     * @minLength 1
     * @maxLength 72
     */
    password: string;
    /**
     * @maxLength 1000
     */
    message?: string;
    ticket?: string;
    method?: "totp" | "backup" | "webauthn";
    code?: string;
    appeal_ticket?: string;
}
