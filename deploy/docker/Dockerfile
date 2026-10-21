# One image for every bot: the bridge, Claude Code and lark-cli on Node 22.
# Each bot runs it in its own container with its own home volume.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ARG LARK_CLI_VERSION=latest

# curl: lark-cli's npm install script downloads its binary with it
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini tzdata \
 && rm -rf /var/lib/apt/lists/*

# The bridge is this repo's build, not the npm release: see "Packing the bridge" in README.md.
COPY lark-channel-bridge.tgz /tmp/lark-channel-bridge.tgz
RUN npm install -g \
      /tmp/lark-channel-bridge.tgz \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@larksuite/cli@${LARK_CLI_VERSION}" \
 && rm /tmp/lark-channel-bridge.tgz \
 && npm cache clean --force

# Unprivileged user. A fixed home so volumes keep the same layout across rebuilds.
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/bot --shell /usr/sbin/nologin bot \
 && install -d -m 700 -o bot -g bot /home/bot/workspace

COPY workspace-settings.json /opt/lark-bot/workspace-settings.json
COPY entrypoint.sh /usr/local/bin/lark-bot-entrypoint
RUN chmod 755 /usr/local/bin/lark-bot-entrypoint

ENV HOME=/home/bot \
    LARK_CHANNEL_HOME=/home/bot/.lark-channel \
    DISABLE_AUTOUPDATER=1

USER bot
WORKDIR /home/bot/workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lark-bot-entrypoint"]
CMD ["lark-channel-bridge", "run"]
