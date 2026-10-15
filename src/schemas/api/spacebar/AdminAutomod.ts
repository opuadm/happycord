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
    action: "log" | "delete" | "timeout" | "hold" | "suspend" | "disable" | "name";
    /**
     * @minimum 1
     * @maximum 365
     */
    suspendDays?: number;
}

export type AdminAutomodSpamAction = "log" | "delete" | "timeout" | "hold" | "suspend" | "disable";

export interface AdminAutomodSpamRuleSchema {
    enabled?: boolean;
    action?: AdminAutomodSpamAction;
    /**
     * @minimum 0
     * @maximum 3650
     */
    exemptAccountAgeDays?: number;
    /**
     * @minimum 1
     * @maximum 86400
     */
    windowSeconds?: number;
}

export interface AdminAutomodSpamSchema {
    everyone?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 1
         * @maximum 1000
         */
        unpermittedLimit?: number;
        /**
         * @minimum 1
         * @maximum 1000
         */
        permittedLimit?: number;
    };
    mentions?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 1
         * @maximum 1000
         */
        messageLimit?: number;
        /**
         * @minimum 1
         * @maximum 10000
         */
        windowLimit?: number;
    };
    flood?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 2
         * @maximum 1000
         */
        messageLimit?: number;
        /**
         * @minimum 2
         * @maximum 1000
         */
        channelLimit?: number;
        /**
         * @minimum 1
         * @maximum 86400
         */
        channelWindowSeconds?: number;
    };
    duplicates?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 1
         * @maximum 2000
         */
        minLength?: number;
        /**
         * @minimum 2
         * @maximum 1000
         */
        channelLimit?: number;
        /**
         * @minimum 2
         * @maximum 1000
         */
        accountLimit?: number;
    };
    links?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 1
         * @maximum 1000
         */
        inviteLimit?: number;
        /**
         * @minimum 1
         * @maximum 1000
         */
        linkLimit?: number;
    };
    burst?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 2
         * @maximum 1000
         */
        accountLimit?: number;
        /**
         * @minimum 1
         * @maximum 2000
         */
        minLength?: number;
    };
    attachments?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 2
         * @maximum 1000
         */
        channelLimit?: number;
        /**
         * @minimum 2
         * @maximum 1000
         */
        accountLimit?: number;
        /**
         * @minimum 0
         * @maximum 104857600
         */
        minBytes?: number;
    };
    dms?: AdminAutomodSpamRuleSchema & {
        /**
         * @minimum 0
         * @maximum 10000
         */
        openLimit?: number;
        /**
         * @minimum 0
         * @maximum 10000
         */
        friendRequestLimit?: number;
        /**
         * @minimum 0
         * @maximum 10000
         */
        sameContentLimit?: number;
        /**
         * @minimum 1
         * @maximum 2000
         */
        minLength?: number;
        /**
         * @minimum 0
         * @maximum 8760
         */
        newAccountHours?: number;
        /**
         * @minimum 0
         * @maximum 10000
         */
        newAccountDmsPerHour?: number;
    };
    /**
     * @minimum 1
     * @maximum 40320
     */
    timeoutMinutes?: number;
    /**
     * @maxItems 500
     */
    ignoreLinkDomains?: string[];
    /**
     * @minimum 1
     * @maximum 8760
     */
    suspendHours?: number;
    /**
     * @minimum 0
     * @maximum 100
     */
    escalateAfterStrikes?: number;
    /**
     * @minimum 1
     * @maximum 720
     */
    strikeWindowHours?: number;
}

export interface AdminAutomodRaidSchema {
    /**
     * @minimum 0
     * @maximum 100000
     */
    raidJoinThreshold?: number;
    /**
     * @minimum 10
     * @maximum 86400
     */
    raidJoinWindowSeconds?: number;
    /**
     * @minimum 0
     * @maximum 100000
     */
    raidNewAccountJoinThreshold?: number;
    /**
     * @minimum 1
     * @maximum 8760
     */
    raidNewAccountHours?: number;
    /**
     * @minimum 0
     * @maximum 100000
     */
    raidInviteJoinThreshold?: number;
    /**
     * @minimum 0
     * @maximum 1440
     */
    raidPauseInvitesMinutes?: number;
    /**
     * @minimum 0
     * @maximum 100000
     */
    dmRaidThreshold?: number;
    /**
     * @minimum 10
     * @maximum 86400
     */
    dmRaidWindowSeconds?: number;
    /**
     * @minimum 0
     * @maximum 1440
     */
    dmRaidPauseDmsMinutes?: number;
    /**
     * @minimum 0
     * @maximum 100000
     */
    mentionRaidThreshold?: number;
    /**
     * @minimum 10
     * @maximum 86400
     */
    mentionRaidWindowSeconds?: number;
}

export interface AdminRaidIncidentActionSchema {
    action: "delete_messages" | "suspend" | "disable" | "ban_ip";
    /**
     * Only act on these accounts from the incident. Leave out to act on everyone in it.
     * @maxItems 2000
     */
    user_ids?: string[];
    /**
     * @maxLength 512
     */
    reason?: string;
}

export interface AdminAutomodScamSchema {
    enabled?: boolean;
    action?: AdminAutomodSpamAction;
    lookalikes?: boolean;
    giftBait?: boolean;
    qrLogin?: boolean;
    ipLoggers?: boolean;
    /**
     * @minimum 0
     * @maximum 3650
     */
    shortenerAccountAgeDays?: number;
    /**
     * @maxItems 2000
     */
    extraDomains?: string[];
    /**
     * @maxItems 2000
     */
    allowDomains?: string[];
    /**
     * @maxLength 2048
     */
    remoteListUrl?: string;
    /**
     * @minimum 15
     * @maximum 10080
     */
    remoteListRefreshMinutes?: number;
}

export interface AdminAutomodSignupSchema {
    enabled?: boolean;
    /**
     * @minimum 0
     * @maximum 1000
     */
    logScore?: number;
    /**
     * @minimum 0
     * @maximum 1000
     */
    holdScore?: number;
    /**
     * @minimum 0
     * @maximum 1000
     */
    refuseScore?: number;
    /**
     * @minimum 1
     * @maximum 1440
     */
    windowMinutes?: number;
    /**
     * @minimum 0
     * @maximum 1000
     */
    disposableEmailWeight?: number;
    /**
     * @minimum 0
     * @maximum 1000
     */
    similarNameWeight?: number;
    /**
     * @minimum 2
     * @maximum 1000
     */
    similarNameLimit?: number;
    /**
     * @minimum 0
     * @maximum 1000
     */
    samePasswordWeight?: number;
    /**
     * @minimum 2
     * @maximum 1000
     */
    samePasswordLimit?: number;
    /**
     * @minimum 0
     * @maximum 1000
     */
    fastCaptchaWeight?: number;
    /**
     * @minimum 0
     * @maximum 60000
     */
    fastCaptchaMs?: number;
    /**
     * @maxItems 2000
     */
    deniedEmailDomains?: string[];
    /**
     * @maxItems 2000
     */
    allowedEmailDomains?: string[];
}

export interface AdminAutomodQuarantineSchema {
    enabled?: boolean;
    /**
     * @minimum 1
     * @maximum 8760
     */
    hours?: number;
    allowLinks?: boolean;
    allowAttachments?: boolean;
    allowEmbeds?: boolean;
    /**
     * @minimum 0
     * @maximum 100
     */
    maxMentions?: number;
    /**
     * @minimum 0
     * @maximum 1000
     */
    maxDms?: number;
}

export interface AdminAutomodSettingsSchema {
    spam?: AdminAutomodSpamSchema;
    raids?: AdminAutomodRaidSchema;
    slurs?: {
        enabled?: boolean;
        action?: AdminAutomodSpamAction;
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
    /**
     * @maxItems 500
     */
    ipAllowList?: string[];
    scam?: AdminAutomodScamSchema;
    signup?: AdminAutomodSignupSchema;
    quarantine?: AdminAutomodQuarantineSchema;
    verification?: {
        enforce?: boolean;
        requirePhoneForHighest?: boolean;
    };
    explicitContent?: {
        enabled?: boolean;
        flagAllMedia?: boolean;
        /**
         * @maxItems 500
         */
        terms?: string[];
        /**
         * @maxItems 5000
         */
        blockedHashes?: string[];
    };
    federation?: {
        reportToHome?: boolean;
        acceptReports?: boolean;
        /**
         * @minimum 0
         * @maximum 100000
         */
        reportsPerHourPerInstance?: number;
    };
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
        /**
         * @minimum 0
         * @maximum 100000
         */
        maxAccountsPerIp?: number;
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
        /**
         * @minimum 0
         * @maximum 100000
         */
        maxAccountsPerIp?: number;
        /**
         * @minimum 1
         * @maximum 365
         */
        sessionActiveDays?: number;
    };
}

export interface AdminAutomodTestSchema {
    /**
     * @maxLength 4000
     */
    text: string;
    /**
     * @maxLength 320
     */
    email?: string;
    /**
     * @maxLength 64
     */
    username?: string;
    /**
     * @maxLength 64
     */
    ip?: string;
}

export interface AdminAutomodAppealDecisionSchema {
    decision: "accept" | "deny";
}

export interface AdminAutomodReverseSchema {
    reversal: "undo" | "not_a_match" | "false_positive";
}

export interface AdminAutomodRulePolicySchema {
    enabled?: boolean;
    action?: AdminAutomodSpamAction;
    dryRun?: boolean;
    exemptStaff?: boolean;
    exemptBots?: boolean;
    exemptVerifiedEmail?: boolean;
    /**
     * @minimum 0
     * @maximum 3650
     */
    exemptAccountAgeDays?: number;
    /**
     * @maxItems 500
     */
    exemptUserIds?: string[];
    /**
     * @maxItems 500
     */
    exemptGuildIds?: string[];
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
