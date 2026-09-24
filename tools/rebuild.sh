#!/bin/sh
# Rebuild both binaries in app/target so the paths people actually launch are current.
# Called by the post-commit and post-merge hooks; safe to run by hand.
#
# include_dir! reads web/ when the macro expands, so a build carries a copy of the
# dashboard inside it. A binary left from an earlier commit serves an older UI and
# nothing on screen says so, which is why this exists.
set -e
cd "$(dirname "$0")/../app"

build() {
  if [ -x "$HOME/.local/bin/claude-heavy" ]; then
    "$HOME/.local/bin/claude-heavy" --timeout 1800 cargo build --release -j2 "$@"
  else
    nice -n 19 cargo build --release -j2 "$@"
  fi
}

build
if rustup target list --installed 2>/dev/null | grep -q x86_64-unknown-linux-musl; then
  build --target x86_64-unknown-linux-musl
fi
