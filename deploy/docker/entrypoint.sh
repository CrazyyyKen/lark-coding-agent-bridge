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

# A bot assigned to a Claude account uses that account or nothing. Until the account's
# credential is saved, the shared one must not stand in: usage would land on another seat.
if [ -n "${LARK_BOT_CLAUDE_WANT:-}" ] && [ "${LARK_BOT_CLAUDE_ACCOUNT:-}" != "$LARK_BOT_CLAUDE_WANT" ]; then
  unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
fi

mkdir -p "$HOME/workspace/.claude"
if [ ! -f "$HOME/workspace/.claude/settings.json" ]; then
  cp /opt/lark-bot/workspace-settings.json "$HOME/workspace/.claude/settings.json"
fi

# New bots default to Sonnet 5.5; picking a model in /config still overrides it.
if [ ! -f "$HOME/.claude/settings.json" ]; then
  mkdir -p "$HOME/.claude"
  printf '{\n  "model": "claude-sonnet-5-5"\n}\n' > "$HOME/.claude/settings.json"
fi

exec "$@"
