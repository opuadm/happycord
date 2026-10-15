import { Channel, Member, Recipient, Stream, StreamSession, VoiceState } from "@spacebar/database";
import { genVoiceToken, Payload, WebSocket, generateStreamKey } from "@spacebar/gateway";
import { Config, emitEvent, FederatedVoice, getPermission, Snowflake, StreamCreateEvent, StreamServerUpdateEvent, VoiceStateUpdateEvent } from "@spacebar/util";
import { check } from "./instanceOf";
import { StreamCreateSchema } from "@spacebar/schemas";

export async function onStreamCreate(this: WebSocket, data: Payload) {
    const startTime = Date.now();
    check.call(this, StreamCreateSchema, data.d);
    const body = data.d as StreamCreateSchema;

    if (body.channel_id.trim().length === 0) return;
    if (await FederatedVoice.relayStream(this.user_id, this.session_id, "create", { ...body })) return;

    // first check if we are in a voice channel already. cannot create a stream if there's no existing voice connection
    const voiceState = await VoiceState.findOne({
        where: { user_id: this.user_id },
    });

    if (!voiceState || !voiceState.channel_id) return;

    if (body.channel_id !== voiceState.channel_id || (body.guild_id ?? null) !== (voiceState.guild_id ?? null)) return;

    if (voiceState.guild_id) {
        if (!(await Member.exists({ where: { id: this.user_id, guild_id: voiceState.guild_id } }))) return;
        voiceState.member = await Member.findOneOrFail({
            where: { id: voiceState.user_id, guild_id: voiceState.guild_id },
            relations: { user: true, roles: true },
        });
    }

    if (voiceState.guild_id) {
        const permission = await getPermission(this.user_id, voiceState.guild_id, voiceState.channel_id);
        if (!(["VIEW_CHANNEL", "CONNECT", "STREAM"] as const).every((required) => permission.has(required))) return;
    } else if (!(await Recipient.exists({ where: { channel_id: voiceState.channel_id, user_id: this.user_id } }))) return;

    const channel = await Channel.findOne({
        where: { id: body.channel_id },
    });

    if (!channel || channel.guild_id !== voiceState.guild_id || (body.type === "guild") !== !!channel.guild_id) return;

    // TODO: actually apply preferred_region from the event payload
    const regions = Config.get().regions;
    const guildRegion = regions.available.find((r) => r.id === regions.default);

    if (!guildRegion) {
        throw new Error("No default region configured");
    }

    // first make sure theres no other streams for this user that somehow didnt get cleared
    await Stream.delete({
        owner_id: this.user_id,
    });

    // create a new entry in db containing the token for authenticating user in stream gateway IDENTIFY
    const stream = Stream.create({
        id: Snowflake.generate(),
        owner_id: this.user_id,
        channel_id: body.channel_id,
        endpoint: guildRegion.endpoint,
    });

    await stream.save();

    const token = genVoiceToken();

    const streamSession = StreamSession.create({
        stream_id: stream.id,
        user_id: this.user_id,
        session_id: this.session_id,
        token,
    });

    await streamSession.save();

    const streamKey = generateStreamKey(body.type, body.guild_id, body.channel_id, this.user_id);

    await emitEvent({
        event: "STREAM_CREATE",
        data: {
            stream_key: streamKey,
            rtc_server_id: stream.id, // for voice connections in guilds it is guild_id, for dm voice calls it seems to be DM channel id, for GoLive streams a generated number
            rtc_channel_id: (BigInt(stream.id) - 1n).toString(),
            viewer_ids: [],
            region: guildRegion.name,
            paused: false,
        },
        user_id: this.user_id,
    } satisfies StreamCreateEvent);

    await emitEvent({
        event: "STREAM_SERVER_UPDATE",
        data: {
            token: streamSession.token,
            stream_key: streamKey,
            guild_id: null, // not sure why its always null
            endpoint: stream.endpoint,
        },
        user_id: this.user_id,
    } satisfies StreamServerUpdateEvent);

    voiceState.self_stream = true;
    await voiceState.save();

    await emitEvent({
        event: "VOICE_STATE_UPDATE",
        data: {
            ...voiceState.toPublicVoiceState(),
            member: voiceState.member?.toPublicMember(),
        },
        guild_id: voiceState.guild_id,
        channel_id: voiceState.channel_id,
    } satisfies VoiceStateUpdateEvent);

    console.log(`[Gateway/${this.user_id}] STREAM_CREATE for user ${this.user_id} in channel ${body.channel_id} with stream key ${streamKey} in ${Date.now() - startTime}ms`);
}

//stream key:
// guild:${guild_id}:${channel_id}:${user_id}
// call:${channel_id}:${user_id}
