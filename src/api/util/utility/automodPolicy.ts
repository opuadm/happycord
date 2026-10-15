/* SPDX-License-Identifier: AGPL-3.0-only */
import { Config, isStaffAccount, loadStaffRoles, Snowflake } from "@spacebar/util";
import type { AutomodPolicyKey } from "@spacebar/util/config/types/AutomodConfiguration";
import { PolicyExemption, policyExemption, policyFor } from "@spacebar/util/util/AutomodPolicy";

export interface PolicyAccount {
    id: string;
    bot?: boolean | null;
    verified?: boolean | null;
    rights?: string | bigint | number | null;
    federated_instance?: string | null;
    created_at?: Date | string | null;
    staff?: boolean;
}

export const rulePolicy = (key: AutomodPolicyKey) => policyFor(Config.get().automod.policies, key);

export const isDryRun = (key: AutomodPolicyKey) => rulePolicy(key).dryRun;

export const ruleSwitchOn = (key: AutomodPolicyKey) => rulePolicy(key).enabled;

export function createdAtOf(account: Pick<PolicyAccount, "id" | "federated_instance" | "created_at">) {
    const created = account.federated_instance && account.created_at ? new Date(account.created_at).getTime() : Number.NaN;
    return Number.isNaN(created) ? Snowflake.deconstruct(account.id).timestamp : created;
}

export async function exemptionFrom(key: AutomodPolicyKey, account: PolicyAccount | null | undefined, guild_id?: string | null): Promise<PolicyExemption | null> {
    const policy = rulePolicy(key);
    const staff =
        !!account && policy.exemptStaff && (account.staff ?? (account.rights !== undefined && isStaffAccount({ id: account.id, rights: account.rights }, await loadStaffRoles())));
    return policyExemption(
        policy,
        account
            ? {
                  user_id: account.id,
                  bot: account.bot,
                  verified: account.verified,
                  federated: !!account.federated_instance,
                  staff,
                  createdAt: policy.exemptAccountAgeDays > 0 ? createdAtOf(account) : null,
              }
            : null,
        guild_id,
    );
}
