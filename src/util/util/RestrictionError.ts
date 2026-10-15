/* SPDX-License-Identifier: AGPL-3.0-only */

export interface RestrictionBody {
    code: number;
    message: string;
    restriction: string;
    reason?: string;
    ends_at?: string;
}

export const restrictionError = (status: number, body: RestrictionBody) => Object.assign(new Error(body.message), { name: "ResponseError", status, body });
