/* SPDX-License-Identifier: AGPL-3.0-only */
import { Guild, Member, User } from "@spacebar/database";
import { ApiError, emitEvent, FederationRequestError, GuildCreateEvent, isInstanceId } from "@spacebar/util";
import { fromWire } from "./federationIds";
import { deleteMirrorGuild, guildCreatePayload, recordJoinIntent, serialized, upsertMirrorGuild, upsertMirrorMember } from "./federationMirrors";
import { hostAnswerError, hostTransportError, ownInstance, signedFetch, trustDecision } from "./federationNetwork";
import { relayToHost } from "./federationRelay";
import { profileOf, upsertShadows } from "./federationShadows";
import { applyRemoteVoiceState } from "./federationVoice";

type Raw = Record<string, unknown>;

export const JOIN_REQUEST_TIMEOUT = 20_000;
export const JOIN_DEADLINE = 28_000;
const UNKNOWN_SENDER_RETRY = 3_000;

const PROFILE_SELECT = {
    id: true,
    username: true,
    global_name: true,
    avatar: true,
    avatar_decoration_data: true,
    banner: true,
    accent_color: true,
    pronouns: true,
    bio: true,
    public_flags: true,
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const remoteFailure = (error: unknown) => {
    if (error instanceof FederationRequestError) return { status: error.status === 401 ? 403 : error.status, body: { code: 0, message: error.message, meowcord_code: error.code } };
    if (error instanceof ApiError) return { status: error.httpStatus, body: { code: error.code, message: error.message } };
    console.error("[Federation] A request to another instance failed on this instance:", error);
    return { status: 500, body: { code: 0, message: "Something went wrong on this instance while talking to the other instance. Try again.", meowcord_code: "internal" } };
};

export function withDeadline<T>(work: Promise<T>, ms: number, late: () => Error) {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            work.catch((error) => console.warn("[Federation] Work that missed its deadline failed later:", (error as Error)?.message ?? error));
            reject(late());
        }, ms);
    });
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

async function assertRemote(instance: string, code: string) {
    if (!isInstanceId(instance) || instance === ownInstance()) throw new ApiError("Unknown instance", 10_000, 404);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(code)) throw new ApiError("Unknown Invite", 10_006, 404);
    const decision = await trustDecision(instance);
    if (!decision.trust) throw new FederationRequestError("not_federated", `This instance doesn't federate with ${instance}. ${decision.detail}`, 403);
}

export async function previewRemoteInvite(user_id: string, instance: string, code: string) {
    try {
        await assertRemote(instance, code);
        const user = await User.findOneOrFail({ where: { id: user_id }, select: PROFILE_SELECT });
        const response = await relayToHost(instance, user, "GET", `/invites/${encodeURIComponent(code)}`);
        return { status: response.status, body: response.body };
    } catch (error) {
        return remoteFailure(error);
    }
}

const askHost = (instance: string, user: User, code: string, timeoutMs: number) =>
    signedFetch<Raw>(instance, "POST", "/federation/v2/join", { actor: `@${user.id}@${ownInstance()}`, code, profile: profileOf(user) }, timeoutMs).catch((error) => {
        throw hostTransportError(instance, error);
    });

async function joinThroughHost(user_id: string, instance: string, code: string) {
    const started = Date.now();
    await assertRemote(instance, code);
    const user = await User.findOneOrFail({ where: { id: user_id }, select: PROFILE_SELECT });
    recordJoinIntent(instance, user_id);
    let response = await askHost(instance, user, code, JOIN_REQUEST_TIMEOUT);
    if (response.status === 403 && response.body?.code === "unknown_sender") {
        await sleep(UNKNOWN_SENDER_RETRY);
        const left = JOIN_DEADLINE - (Date.now() - started) - 2_000;
        if (left >= 2_000) response = await askHost(instance, user, code, Math.min(JOIN_REQUEST_TIMEOUT, Math.round(left)));
    }
    if (response.status !== 200) throw hostAnswerError(instance, response.status, response.body);
    if (!response.body || typeof response.body !== "object" || "raw" in response.body || !("invite" in response.body || "snapshot" in response.body))
        throw hostAnswerError(instance, response.status, response.body ?? {});
    const data = (await fromWire(response.body, instance, upsertShadows)) as {
        invite?: Raw;
        snapshot?: { guild: Raw; members?: Raw[]; member?: Raw } | null;
        pending?: boolean;
    };
    if (!data.snapshot) {
        const invite = data.invite ?? {};
        return { status: 200, body: { ...invite, new_member: !!invite.show_verification_form, meowcord_pending: true } };
    }
    const snapshot = data.snapshot;
    const localGuild = String(snapshot.guild.id);
    const name = typeof snapshot.guild.name === "string" ? snapshot.guild.name : "the server";
    const existed = await Guild.exists({ where: { id: localGuild } });
    let guild_id: string;
    try {
        guild_id = await serialized(`guild:${localGuild}`, async () => {
            const id = await upsertMirrorGuild(snapshot.guild, instance);
            if (!id) throw new ApiError("That server clashes with an object on this instance", 0, 409);
            for (const member of snapshot.members ?? []) await upsertMirrorMember(member, id);
            if (snapshot.member) await upsertMirrorMember({ ...snapshot.member, user: { id: user_id } }, id, { joining: user_id });
            if (!(await Member.exists({ where: { id: user_id, guild_id: id } }))) await upsertMirrorMember({ user: { id: user_id }, roles: [] }, id, { joining: user_id });
            for (const state of Array.isArray(snapshot.guild.voice_states) ? snapshot.guild.voice_states : [])
                if (state && typeof state === "object") await applyRemoteVoiceState(state as Raw, { guild_id: id }, false);
            const count = Number(snapshot.guild.member_count);
            if (Number.isSafeInteger(count)) await Guild.update({ id }, { member_count: count });
            return id;
        });
    } catch (error) {
        if (error instanceof ApiError) throw error;
        console.error(`[Federation] Copying ${localGuild} from ${instance} failed:`, error);
        if (!existed) await deleteMirrorGuild(localGuild).catch((cleanup) => console.error(`[Federation] Removing the partial copy of ${localGuild} failed:`, cleanup));
        throw new FederationRequestError(
            "mirror_failed",
            `You joined ${name} on ${instance}, but this instance couldn't copy the server. Joining again is safe, so try again.`,
            502,
        );
    }
    const guild = await guildCreatePayload(guild_id, user_id).catch((error) => {
        console.error(`[Federation] Building GUILD_CREATE for ${guild_id} failed:`, error);
        return null;
    });
    if (guild)
        await emitEvent({ event: "GUILD_CREATE", data: guild as unknown as GuildCreateEvent["data"], user_id, origin: "federation" } as GuildCreateEvent).catch((error) =>
            console.error(`[Federation] Sending GUILD_CREATE for ${guild_id} failed:`, error),
        );
    return { status: 200, body: { ...(data.invite ?? {}), guild_id, new_member: true, ...(guild && { meowcord_guild: guild }) } };
}

export async function joinRemoteInvite(user_id: string, instance: string, code: string) {
    try {
        return await withDeadline(
            joinThroughHost(user_id, instance, code),
            JOIN_DEADLINE,
            () =>
                new FederationRequestError(
                    "join_timeout",
                    `Joining through ${instance} took longer than ${JOIN_DEADLINE / 1000} seconds. If ${instance} let you in, the server shows up in your list once this instance finishes copying it.`,
                    504,
                ),
        );
    } catch (error) {
        return remoteFailure(error);
    }
}
