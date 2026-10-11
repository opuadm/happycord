#!/bin/sh
set -e
cd "$(dirname "$0")/../.."
port="${1:?usage: worktree-setup.sh <port> <db-name>}"
db="${2:?usage: worktree-setup.sh <port> <db-name>}"
case "$port" in
    ""|0*|*[!0-9]*) echo "use a port from 1 through 63535" >&2; exit 1 ;;
esac
[ "${#port}" -le 5 ] && [ "$port" -le 63535 ] || { echo "use a port from 1 through 63535" >&2; exit 1; }
case "$db" in
    ""|*[!a-z0-9_]*) echo "use lowercase letters, digits and underscores for the database name" >&2; exit 1 ;;
esac
[ "${#db}" -le 63 ] || { echo "database name must fit in 63 characters" >&2; exit 1; }
for file in .env* config.json; do
    [ -e "$file" ] || [ -L "$file" ] || continue
    [ "$file" = .env.example ] && continue
    echo "refusing to overwrite existing runtime configuration: $file" >&2
    exit 1
done
command -v lsof >/dev/null || { echo "install lsof before preparing the development instance" >&2; exit 1; }
for tcp_port in "$port" "$((port + 1000))"; do
    if lsof -tiTCP:"$tcp_port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "TCP port $tcp_port is already occupied; choose another base port" >&2
        exit 1
    fi
done
if lsof -tiUDP:"$((port + 2000))" >/dev/null 2>&1; then
    echo "UDP port $((port + 2000)) is already occupied; choose another base port" >&2
    exit 1
fi
existing=$(psql --host=localhost --port=5432 --username="$USER" postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'")
[ -z "$existing" ] || { echo "database $db already exists; choose a fresh isolated name" >&2; exit 1; }
createdb --host=localhost --port=5432 --username="$USER" "$db"
echo "created isolated database $db"
umask 077
main="$(git worktree list --porcelain | awk 'NR==1{print $2}')"
if [ "$main" != "$PWD" ]; then
    [ -e assets/cache ] || ln -s "$main/assets/cache" assets/cache
    [ -e assets/cache_compressed ] || [ ! -d "$main/assets/cache_compressed" ] || ln -s "$main/assets/cache_compressed" assets/cache_compressed
    [ -e assets/vencord ] || [ ! -d "$main/assets/vencord" ] || ln -s "$main/assets/vencord" assets/vencord
fi
[ -L node_modules ] && rm node_modules
bun install --frozen-lockfile
cat > .env <<ENV
DATABASE=postgres://$USER@localhost:5432/$db
PORT=$port
WRTC_WS_PORT=$((port + 1000))
NODE_ENV=development
CONFIG_PATH=$PWD/config.json
PUBLIC_FETCH_PROXY=direct
ENV
sfu_bin=""
if command -v go >/dev/null && (cd extra/pion-sfu && go build -o pion-sfu .); then
    sfu_bin="$PWD/extra/pion-sfu/pion-sfu"
    cat >> .env <<ENV
PION_SFU_BIN=$PWD/extra/pion-sfu/pion-sfu
WRTC_PUBLIC_IP=127.0.0.1
WRTC_PORT_MIN=$((port + 2000))
WRTC_PORT_MAX=$((port + 2000))
ENV
fi
cat > config.json <<JSON
{
  "general": { "serverName": "http://localhost:$port" },
  "api": { "endpointPublic": "http://localhost:$port/api/v9" },
  "cdn": { "endpointPublic": "http://localhost:$port/", "endpointPrivate": "http://localhost:$port/" },
  "gateway": { "endpointPublic": "ws://localhost:$port/" },
  "limits": {
    "rate": {
      "routes": {
        "auth": {
          "login": { "count": 1000, "window": 60 },
          "register": { "count": 1000, "window": 60 }
        }
      }
    }
  }
}
JSON
bun run build:src >/dev/null
DATABASE="postgres://$USER@localhost:5432/$db" CONFIG_PATH="$PWD/config.json" NODE_ENV=development PORT=$port WRTC_WS_PORT=$((port + 1000)) PION_SFU_BIN="$sfu_bin" WRTC_PUBLIC_IP=127.0.0.1 WRTC_PORT_MIN=$((port + 2000)) WRTC_PORT_MAX=$((port + 2000)) nohup bun dist/bundle/start.js > "$PWD/server.log" 2>&1 &
server_pid=$!
ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
        wait "$server_pid" || true
        echo "the owned server exited before readiness; inspect $PWD/server.log" >&2
        exit 1
    fi
    listener=$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)
    if [ -n "$listener" ] && [ "$listener" != "$server_pid" ]; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" || true
        echo "TCP port $port was claimed by another process; the other process was left running" >&2
        exit 1
    fi
    if [ "$listener" = "$server_pid" ] && curl -sf --max-time 1 "http://localhost:$port/readyz" >/dev/null && curl -sf --max-time 1 "http://localhost:$port/api/ping" >/dev/null && curl -sf --max-time 1 "http://localhost:$port/login" >/dev/null; then
        ready=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
if [ "$ready" != 1 ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" || true
    echo "the owned server did not become ready; inspect $PWD/server.log" >&2
    exit 1
fi
PORT=$port bun scripts/dev/seed.mjs
echo "ready: http://localhost:$port, db $db, log $PWD/server.log"
