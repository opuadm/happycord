/* SPDX-License-Identifier: AGPL-3.0-only */
export interface AdminStaffRoleCreateSchema {
    /**
     * @minLength 1
     * @maxLength 64
     */
    name: string;
    /**
     * @TJS-type integer
     * @minimum 0
     * @maximum 16777215
     */
    color?: number | null;
    /**
     * A decimal rights bitfield. OPERATOR can't be part of a role.
     * @pattern ^[0-9]{1,20}$
     */
    rights?: string;
    /**
     * @TJS-type integer
     * @minimum 1
     * @maximum 1000
     */
    position?: number;
    show_badge?: boolean;
}

export interface AdminStaffRoleModifySchema {
    /**
     * @minLength 1
     * @maxLength 64
     */
    name?: string;
    /**
     * @TJS-type integer
     * @minimum 0
     * @maximum 16777215
     */
    color?: number | null;
    /**
     * @pattern ^[0-9]{1,20}$
     */
    rights?: string;
    /**
     * @TJS-type integer
     * @minimum 1
     * @maximum 1000
     */
    position?: number;
    show_badge?: boolean;
}

export type AdminStaffRolePositionsSchema = {
    /**
     * @pattern ^[0-9]{1,20}$
     */
    id: string;
    /**
     * @TJS-type integer
     * @minimum 1
     * @maximum 1000
     */
    position: number;
}[];

export interface AdminUserStaffRolesSchema {
    /**
     * @maxItems 50
     */
    role_ids: string[];
}
