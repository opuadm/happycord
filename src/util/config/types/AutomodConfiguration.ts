/* SPDX-License-Identifier: AGPL-3.0-only */

export class AutomodSlurConfiguration {
    enabled: boolean = true;
    includeSoftA: boolean = false;
    suspendDays: number = 7;
    deleteAllMessages: boolean = true;
    violationDays: number = 90;
    actOnVerifiedReports: boolean = true;
}

export type AutomodWordListAction = "delete" | "suspend" | "name";

export interface AutomodWordList {
    id: string;
    name: string;
    terms: string[];
    action: AutomodWordListAction;
    suspendDays: number;
}

export class AutomodRegistrationConfiguration {
    maxAccountsPerIpPerDay: number = 0;
}

export class AutomodLoginConfiguration {
    maxFailedAttemptsPerAccount: number = 10;
    lockoutMinutes: number = 15;
}

export class AutomodConfiguration {
    slurs: AutomodSlurConfiguration = new AutomodSlurConfiguration();
    wordLists: AutomodWordList[] = [];
    allowList: string[] = [];
    registration: AutomodRegistrationConfiguration = new AutomodRegistrationConfiguration();
    login: AutomodLoginConfiguration = new AutomodLoginConfiguration();
}
