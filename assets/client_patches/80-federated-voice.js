(() => {
  const NativeSocket = window.WebSocket;
  const NativeConnection = window.RTCPeerConnection;
  if (!NativeSocket || !NativeConnection) return;
  const sockets = new Map();
  const relayed = new WeakMap();
  const daveIds = new Map();
  const localIds = new Map();
  const groups = new Map();
  const pathOf = (url) => {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.searchParams.has("encoding") ? null : parsed.pathname;
    } catch {
      return null;
    }
  };
  const open = (socket) => socket.readyState <= NativeSocket.OPEN;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const socket = new target(...args);
      const path = pathOf(args[0]);
      if (path === null) return socket;
      const federated = path.startsWith("/federated-voice");
      if (federated) sockets.set(socket, null);
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || !event.data.includes("meowcord_")) return;
        try {
          const message = JSON.parse(event.data);
          if (federated && message.op === 2 && message.d?.meowcord_relay) sockets.set(socket, message.d.meowcord_relay);
          const dave = message.d?.meowcord_dave;
          if (message.op === 4 && typeof dave?.channel_id === "string" && /^\d+$/.test(dave.group ?? "")) groups.set(dave.channel_id, dave.group);
          if (message.op === 11 && Array.isArray(dave))
            for (const entry of dave) {
              if (typeof entry?.user_id !== "string" || !/^\d+$/.test(entry.dave ?? "")) continue;
              daveIds.set(entry.user_id, entry.dave);
              localIds.set(entry.dave, entry.user_id);
            }
        } catch {}
      });
      socket.addEventListener("close", () => sockets.delete(socket));
      return socket;
    },
  });
  window.FosscordFederatedVoice = {
    daveId: (userId) => daveIds.get(String(userId)) ?? String(userId),
    localId: (daveId) => localIds.get(String(daveId)) ?? String(daveId),
    daveGroup: (channelId) => BigInt(groups.get(String(channelId)) ?? channelId),
  };
  const relayFor = () => {
    const live = [...sockets].filter(([socket]) => open(socket));
    if (!live.length) return null;
    const credentials = live.map(([, value]) => value).filter(Boolean).at(-1);
    return {
      iceServers: credentials
        ? [{ urls: credentials.urls, username: credentials.username, credential: credentials.credential }]
        : [],
      iceTransportPolicy: "relay",
    };
  };
  window.RTCPeerConnection = new Proxy(NativeConnection, {
    construct(target, [config, ...rest]) {
      const relay = relayFor();
      const connection = new target(relay ? { ...(config ?? {}), ...relay } : config, ...rest);
      if (relay) relayed.set(connection, relay);
      return connection;
    },
  });
  const setConfiguration = NativeConnection.prototype.setConfiguration;
  NativeConnection.prototype.setConfiguration = function (config) {
    const relay = relayed.get(this);
    return setConfiguration.call(this, relay ? { ...(config ?? {}), ...relay } : config);
  };
})();
