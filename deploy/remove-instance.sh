#!/usr/bin/env bash
# Remove a bot instance made by new-instance.sh: stop its service, archive its
# home folder (root-only), and delete its Linux user.
#
#   sudo bash remove-instance.sh <name> [--no-archive]
#
# The Lark app itself is not deleted; remove it in the Lark developer console.

set -euo pipefail

BASE=/srv/lark
ARCHIVE_DIR="$BASE/.archive"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

NAME=""
ARCHIVE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-archive) ARCHIVE=0; shift ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *)  NAME="$1"; shift ;;
  esac
done

[ -n "$NAME" ] || die "usage: sudo bash $0 <name> [--no-archive]"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "invalid instance name: $NAME"
[ "$(id -u)" -eq 0 ] || die "run as root"
HOME_DIR="$BASE/$NAME"
id -u "$NAME" >/dev/null 2>&1 || [ -e "$HOME_DIR" ] || die "no instance named $NAME"

read -rp "Type '$NAME' to remove this instance: " answer
[ "$answer" = "$NAME" ] || die "cancelled"

systemctl disable --now "lark-bridge@$NAME" >/dev/null 2>&1 || true

if [ "$ARCHIVE" -eq 1 ] && [ -d "$HOME_DIR" ]; then
  install -d -m 700 "$ARCHIVE_DIR"
  out="$ARCHIVE_DIR/$NAME-$(date +%Y%m%d-%H%M%S).tar.gz"
  (umask 077; tar czf "$out" -C "$BASE" "$NAME")
  echo "archived: $out"
fi

if id -u "$NAME" >/dev/null 2>&1; then
  userdel "$NAME"
fi
rm -rf --one-file-system "$HOME_DIR"
echo "removed: $NAME (Linux user, service, $HOME_DIR)"
echo "Delete the Lark app in the Lark developer console if it is no longer needed."
