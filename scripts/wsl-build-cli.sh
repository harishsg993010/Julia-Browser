#!/bin/bash
# Build the Linux release binary of the julia-browser CLI inside WSL.
#   wsl -e bash scripts/wsl-build-cli.sh
# Copies the source to the Linux filesystem (~/jb-build; builds on /mnt/c are very slow), builds
# with --features screenshot,images and copies the binary to target/linux/ in the Windows checkout.
set -e
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=$HOME/jb-build
VENV=$HOME/jb-build-venv
mkdir -p "$WORK"
rsync -a --delete --exclude target --exclude _src --exclude .git --exclude .notes --exclude '*.exe' --exclude '*.whl' "$SRC/" "$WORK/"
# Stylo's build script runs `python`
[ -d "$VENV" ] || python3 -m venv "$VENV"
mkdir -p "$VENV/pybin" && ln -sf "$(command -v python3)" "$VENV/pybin/python" && export PATH="$VENV/pybin:$PATH"
cd "$WORK"
cargo build --release --features screenshot,images --bin julia-browser
mkdir -p "$SRC/target/linux"
cp target/release/julia-browser "$SRC/target/linux/julia-browser"
strip "$SRC/target/linux/julia-browser" || true
"$SRC/target/linux/julia-browser" --version
ls -la "$SRC/target/linux/"
