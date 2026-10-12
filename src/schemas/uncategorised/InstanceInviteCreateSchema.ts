/* SPDX-License-Identifier: AGPL-3.0-only */
export interface InstanceInviteCreateSchema {
    /**
     * How many people can join with the invite
     * @TJS-type integer
     * @minimum 1
     * @maximum 1000
     */
    max_uses?: number;
    /**
     * Seconds until the invite expires
     * @TJS-type integer
     * @minimum 0
     * @maximum 31536000
     */
    max_age_seconds?: number;
}
