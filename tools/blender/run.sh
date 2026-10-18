#!/bin/sh
# Runs Blender with these arguments, one at a time across every session and agent on this machine (several at once
# choke it): waits for the lock, cleared when the holder exits or dies.
#   tools/blender/run.sh -b --python tools/blender/worm.py -- --preview out.png
LOCK=/tmp/dadajam-blender.lock
while ! mkdir "$LOCK" 2>/dev/null; do
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  sleep 2
done
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM
"${BLENDER:-/opt/homebrew/bin/blender}" "$@"
