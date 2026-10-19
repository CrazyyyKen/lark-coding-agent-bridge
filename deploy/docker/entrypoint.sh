#!/bin/sh
# Make sure the bot's workspace and permission template exist in its home
# volume, then run the command (the bridge by default).
set -eu

umask 077
mkdir -p "$HOME/workspace/.claude"
if [ ! -f "$HOME/workspace/.claude/settings.json" ]; then
  cp /opt/lark-bot/workspace-settings.json "$HOME/workspace/.claude/settings.json"
fi

exec "$@"
