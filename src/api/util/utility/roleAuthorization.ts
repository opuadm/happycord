import { Guild, Member, Role } from "@spacebar/database";
import { DiscordApiErrors, getPermission } from "@spacebar/util";

type RoleAuthority = { guildId: string; owner: boolean; highest: number; permissions: bigint };

export async function getRoleAuthority(actorId: string, guildId: string): Promise<RoleAuthority> {
    const permission = await getPermission(actorId, guildId);
    permission.hasThrow("MANAGE_ROLES");
    const guild = await Guild.findOneOrFail({
        where: { id: guildId },
        select: { id: true, owner_id: true },
    });
    if (guild.owner_id === actorId) return { guildId, owner: true, highest: Infinity, permissions: permission.bitfield };
    const member = await Member.findOneOrFail({
        where: { id: actorId, guild_id: guildId },
        relations: { roles: true },
    });
    return {
        guildId,
        owner: false,
        highest: Math.max(0, ...member.roles.filter((role) => role.guild_id === guildId && role.id !== guildId).map((role) => role.position)),
        permissions: permission.bitfield,
    };
}

export function assertRolePosition(authority: RoleAuthority, position: number, creating = false): void {
    if (!Number.isSafeInteger(position) || position < 1) throw DiscordApiErrors.MISSING_PERMISSIONS;
    if (!authority.owner && position >= authority.highest + (creating ? 1 : 0)) throw DiscordApiErrors.MISSING_PERMISSIONS;
}

export function assertRoleEditable(authority: RoleAuthority, role: Role, allowEveryone = false, allowManaged = false): void {
    if (role.guild_id !== authority.guildId) throw DiscordApiErrors.UNKNOWN_ROLE;
    if ((role.managed && !allowManaged) || (role.id === authority.guildId && !allowEveryone)) throw DiscordApiErrors.MISSING_PERMISSIONS;
    if (role.id !== authority.guildId && !authority.owner && role.position >= authority.highest) throw DiscordApiErrors.MISSING_PERMISSIONS;
}

export function authorizeRolePermissions(authority: RoleAuthority, requested: string, previous = "0"): string {
    if (!/^\d+$/.test(requested)) throw DiscordApiErrors.MISSING_PERMISSIONS;
    const permissions = BigInt(requested);
    if (!authority.owner && (permissions & ~BigInt(previous) & ~authority.permissions) !== 0n) throw DiscordApiErrors.MISSING_PERMISSIONS;
    return permissions.toString();
}

export async function authorizeRolePositions(actorId: string, guildId: string, updates: { id: string; position: number }[]): Promise<void> {
    const ids = new Set(updates.map((update) => update.id));
    if (ids.size !== updates.length) throw DiscordApiErrors.MISSING_PERMISSIONS;
    const authority = await getRoleAuthority(actorId, guildId);
    if (!updates.length) return;
    const roles = await Role.find({ where: [...ids].map((id) => ({ id, guild_id: guildId })) });
    const byId = new Map(roles.map((role) => [role.id, role]));
    for (const update of updates) {
        const role = byId.get(update.id);
        if (!role) throw DiscordApiErrors.UNKNOWN_ROLE;
        if (!Number.isSafeInteger(update.position)) throw DiscordApiErrors.MISSING_PERMISSIONS;
        if (update.position === role.position) continue;
        assertRoleEditable(authority, role, false, true);
        assertRolePosition(authority, update.position);
    }
}
