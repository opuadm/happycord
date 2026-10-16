/* SPDX-License-Identifier: AGPL-3.0-only */
import { Badge, User } from "@spacebar/database";
import { ensureStaffBadge, STAFF_BADGE_ID } from "@spacebar/api/util";
import { Config, instanceName, loadStaffRoles, staffBadgeRole } from "@spacebar/util";
import { PRIDE_BADGES, prideBadges } from "@spacebar/api/util/utility/prideBadges";

export type DirectoryBadge = {
    badge_id: string;
    name: string;
    description: string;
    icon: string;
    simple_icon_url: string;
    complex_icon_static_url: string;
    link: string | null;
    owned: boolean;
    hidden: boolean;
    is_earnable: boolean;
    tiers: never[];
    progress: never[];
    current_tier: null;
    next_tier: null;
    info_label: null;
};

const toDirectoryBadge = (id: string, name: string, description: string, icon: string, link: string | null | undefined, owned: boolean, hidden: boolean): DirectoryBadge => {
    const iconUrl = `${(Config.get().cdn.endpointPublic || "").replace(/\/+$/, "")}/badge-icons/${icon}.png`;
    return {
        badge_id: id,
        name,
        description,
        icon,
        simple_icon_url: iconUrl,
        complex_icon_static_url: iconUrl,
        link: link ?? null,
        owned,
        hidden,
        is_earnable: false,
        tiers: [],
        progress: [],
        current_tier: null,
        next_tier: null,
        info_label: null,
    };
};

export async function userDirectoryBadges(user_id: string, forSelf: boolean) {
    const user = await User.findOneOrFail({ where: { id: user_id }, select: { id: true, badge_ids: true, pride_badges: true, badge_settings: true, federated_instance: true } });
    const ownedIds = new Set((user.badge_ids ?? []).filter((id) => !user.federated_instance || id !== STAFF_BADGE_ID));
    const catalog = await Badge.find({ order: { description: "ASC" } });
    const badges: DirectoryBadge[] = catalog
        .filter((badge) => ownedIds.has(badge.id) || !user.federated_instance)
        .map((badge) => toDirectoryBadge(badge.id, badge.description, badge.description, badge.icon, badge.link, ownedIds.has(badge.id), false));
    const badgeRole = user.federated_instance || ownedIds.has(STAFF_BADGE_ID) ? null : staffBadgeRole(user.id, await loadStaffRoles());
    if (badgeRole) {
        const staffBadge = await ensureStaffBadge();
        badges.unshift(
            toDirectoryBadge(
                `staff-role-${badgeRole.id}`,
                `${instanceName()} ${badgeRole.name}`,
                `${instanceName()} ${badgeRole.name}`,
                staffBadge.icon,
                staffBadge.link,
                true,
                false,
            ),
        );
    }
    for (const badge of prideBadges(user.pride_badges)) badges.push(toDirectoryBadge(badge.id, badge.description, badge.description, badge.icon, null, true, false));

    const hidden = new Set((user.badge_settings?.hidden_badges ?? []).map(String));
    hidden.delete(STAFF_BADGE_ID);
    for (const badge of PRIDE_BADGES) hidden.delete(badge.id);
    const visible = (forSelf ? badges.map((badge) => ({ ...badge, hidden: hidden.has(badge.badge_id) })) : badges.filter((badge) => !hidden.has(badge.badge_id))).filter(
        (badge) => forSelf || badge.owned,
    );
    const order = user.badge_settings?.display_order ?? [];
    if (forSelf && order.length) {
        const rank = new Map(order.map((id, index) => [String(id), index]));
        visible.sort((a, b) => (rank.get(a.badge_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.badge_id) ?? Number.MAX_SAFE_INTEGER));
    }
    return visible;
}
