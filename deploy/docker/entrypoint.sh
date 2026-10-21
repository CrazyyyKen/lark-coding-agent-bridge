#!/bin/sh
# Make sure the bot's workspace and permission template exist in its home
# volume, then run the command (the bridge by default).
set -eu

umask 077

# The shared credential (claude.env) and a bot's own (bots/<name>.claude.env) can set
# different variables, and Claude Code always prefers ANTHROPIC_API_KEY. LARK_BOT_CLAUDE,
# written by `lark-bots.sh set-claude`, says which one this bot is meant to use.
case "${LARK_BOT_CLAUDE:-}" in
  subscription) unset ANTHROPIC_API_KEY ;;
  api-key)      unset CLAUDE_CODE_OAUTH_TOKEN ;;
  own)          unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ;;
esac

mkdir -p "$HOME/workspace/.claude"
if [ ! -f "$HOME/workspace/.claude/settings.json" ]; then
  cp /opt/lark-bot/workspace-settings.json "$HOME/workspace/.claude/settings.json"
fi

exec "$@"
