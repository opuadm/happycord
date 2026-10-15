import { Column, CreateDateColumn, Entity, FindOptionsWhere, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseClass } from "./BaseClass";
import { isPrivateAddress } from "../../util/util/networking/PublicNetwork";
import { isCloudflareAddress } from "../../util/util/networking/Cloudflare";

type BanLookup = { userId?: string; ipAddress?: string; fingerprint?: string };

@Entity({
    name: "instance_bans",
})
export class InstanceBan extends BaseClass {
    @Column({ type: "bigint" })
    @CreateDateColumn()
    created_at: Date = new Date();

    @Column()
    reason: string;

    @Index("IDX_instance_ban_user_id", { type: "hash" })
    @Column({ type: "int8", nullable: true })
    user_id?: string;

    @Index("IDX_instance_ban_fingerprint", { type: "hash" })
    @Column({ nullable: true })
    fingerprint?: string;

    @Index("IDX_instance_ban_ip_address", { type: "hash" })
    @Column({ nullable: true })
    ip_address?: string;

    // chain of trust type tracking

    @Column({ default: false })
    is_allowlisted: boolean = false;

    @Column({ default: false })
    is_from_other_instance_ban: boolean = false;

    @Column({ nullable: true })
    origin_instance_ban_id?: string;

    @JoinColumn({
        name: "origin_instance_ban_id",
        foreignKeyConstraintName: "FK_origin_instance_ban_id",
    })
    @ManyToOne(() => InstanceBan, { nullable: true, onDelete: "SET NULL" })
    origin_instance_ban?: InstanceBan;

    static sharedAddress(ipAddress?: string) {
        return !!ipAddress && (isPrivateAddress(ipAddress) || isCloudflareAddress(ipAddress));
    }

    private static matching(opts: BanLookup) {
        const optionalChecks: FindOptionsWhere<InstanceBan>[] = [];
        if (opts?.userId) optionalChecks.push({ user_id: opts.userId });
        if (opts?.ipAddress && !InstanceBan.sharedAddress(opts.ipAddress)) optionalChecks.push({ ip_address: opts.ipAddress });
        if (opts?.fingerprint) optionalChecks.push({ fingerprint: opts.fingerprint });
        return optionalChecks;
    }

    static spreadReason(origin: InstanceBan) {
        if (origin.ip_address) return `Used the banned address ${origin.ip_address}, ban ${origin.id}`;
        if (origin.user_id) return `Shared an address or browser with the banned account ${origin.user_id}, ban ${origin.id}`;
        return `Used a browser that a banned account used, ban ${origin.id}`;
    }

    static readonly SPREAD_ADDRESS_MS = 7 * 24 * 60 * 60 * 1000;

    static live(ban: InstanceBan, now = Date.now()) {
        if (ban.is_allowlisted) return false;
        if (!ban.is_from_other_instance_ban || (!ban.ip_address && !ban.fingerprint)) return true;
        return now - new Date(ban.created_at).getTime() < InstanceBan.SPREAD_ADDRESS_MS;
    }

    static async hasInstanceBans(opts: BanLookup) {
        const where = InstanceBan.matching(opts);
        if (!where.length) return false;
        const bans = await InstanceBan.find({ where });
        return bans.some((ban) => InstanceBan.live(ban));
    }

    static async findInstanceBans(opts: BanLookup & { propagateBan?: boolean }) {
        const where = InstanceBan.matching(opts);
        const instanceBans = where.length ? await InstanceBan.find({ where }) : [];
        const active = instanceBans.filter((ban) => InstanceBan.live(ban));

        const banReasons = [];
        for (const ban of active) {
            if (opts?.fingerprint && ban.fingerprint === opts.fingerprint) banReasons.push("fingerprint");
            if (opts?.ipAddress && ban.ip_address === opts.ipAddress) banReasons.push("ipAddress");
            if (opts?.userId && ban.user_id === opts?.userId) banReasons.push("userId");
        }

        const origin = active.find((ban) => !ban.is_from_other_instance_ban);
        if (!opts.propagateBan || !origin) return banReasons;
        const spread = (fields: Partial<InstanceBan>) =>
            InstanceBan.create({ ...fields, reason: InstanceBan.spreadReason(origin), is_from_other_instance_ban: true, origin_instance_ban: origin }).save();
        await Promise.all([
            opts?.fingerprint && !instanceBans.some((b) => b.fingerprint === opts.fingerprint) ? spread({ user_id: opts.userId, fingerprint: opts.fingerprint }) : null,
            opts?.userId && !instanceBans.some((b) => b.user_id === opts.userId) ? spread({ user_id: opts.userId }) : null,
        ]);
        return banReasons;
    }
}
