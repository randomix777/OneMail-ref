#!/bin/sh
# Workspace install for web/worker/server images and CI.
# @inboxzero/unsubscribe-worker stays in the lockfile but is not installed.
set -eu
cd "$(dirname "$0")/.."
exec pnpm install --filter '!@inboxzero/unsubscribe-worker' "$@"
