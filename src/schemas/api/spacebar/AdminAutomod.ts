/* SPDX-License-Identifier: AGPL-3.0-only */

export interface AdminAutomodWordListSchema {
    /**
     * @maxLength 64
     */
    id?: string;
    /**
     * @minLength 1
     * @maxLength 64
     */
    name: string;
    /**
     * @maxItems 500
     */
    terms: string[];
    action: "delete" | "suspend" | "name";
    /**
     * @minimum 1
     * @maximum 365
     */
    suspendDays?: number;
}

export interface AdminAutomodSettingsSchema {
    slurs?: {
        enabled?: boolean;
        includeSoftA?: boolean;
        /**
         * @minimum 1
         * @maximum 365
         */
        suspendDays?: number;
        deleteAllMessages?: boolean;
        /**
         * @minimum 1
         * @maximum 3650
         */
        violationDays?: number;
        actOnVerifiedReports?: boolean;
    };
    /**
     * @maxItems 50
     */
    wordLists?: AdminAutomodWordListSchema[];
    /**
     * @maxItems 500
     */
    allowList?: string[];
    /**
     * @maxItems 256
     */
    identityBlockedTerms?: string[];
    registration?: {
        joinReasonRequired?: boolean;
        /**
         * @minimum 1
         * @maximum 1000
         */
        joinReasonMinLength?: number;
        requireApproval?: boolean;
        /**
         * @minimum 0
         * @maximum 100000
         */
        maxAccountsPerIpPerDay?: number;
    };
    login?: {
        /**
         * @minimum 0
         * @maximum 1000
         */
        maxFailedAttemptsPerAccount?: number;
        /**
         * @minimum 1
         * @maximum 10080
         */
        lockoutMinutes?: number;
    };
}

export interface AdminAutomodTestSchema {
    /**
     * @maxLength 4000
     */
    text: string;
}

export interface AdminAutomodReverseSchema {
    reversal: "undo" | "not_a_match";
}

export interface AdminAutomodUsersSchema {
    /**
     * @minItems 1
     * @maxItems 100
     */
    user_ids: string[];
}

export interface AdminJoinRequestActionSchema {
    /**
     * @minItems 1
     * @maxItems 100
     */
    user_ids: string[];
    action: "approve" | "reject";
}
