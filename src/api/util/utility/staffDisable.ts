/* SPDX-License-Identifier: AGPL-3.0-only */
import { UserFlags } from "@spacebar/schemas";

export const STAFF_DISABLED_FLAG = UserFlags.FLAGS.DISABLED;

export const isStaffDisabled = (flags: number | string | bigint | null | undefined) => (BigInt(flags ?? 0) & STAFF_DISABLED_FLAG) !== 0n;

export const withStaffDisabled = (flags: number | string | bigint | null | undefined, disabled: boolean) =>
    Number(disabled ? BigInt(flags ?? 0) | STAFF_DISABLED_FLAG : BigInt(flags ?? 0) & ~STAFF_DISABLED_FLAG);

export const staffDisableColumns = () => ({ disabled: true, flags: () => `flags | ${STAFF_DISABLED_FLAG}` });
