#!/bin/bash
# Build the Linux (manylinux) wheel of the Python package inside WSL.
#   wsl -e bash scripts/wsl-build-wheel.sh [--test]
# Copies the source to the Linux filesystem (~/jb-build; builds on /mnt/c are very slow), builds
# with maturin, lets maturin/auditwheel tag + repair it, and copies the wheel back to
# target/wheels/linux/ in the Windows checkout.
set -e
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=$HOME/jb-build
VENV=$HOME/jb-build-venv
mkdir -p "$WORK"
rsync -a --delete --exclude target --exclude _src --exclude .git --exclude '*.exe' --exclude '*.whl' "$SRC/" "$WORK/"
# CRLF in shell scripts / build files checked out on Windows breaks nothing in cargo, but be safe for .sh
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q "maturin>=1.9,<2" auditwheel patchelf twine
cd "$WORK"
export PATH="$VENV/bin:$PATH"
# Stylo's build script runs `python`
mkdir -p "$VENV/pybin" && ln -sf "$(command -v python3)" "$VENV/pybin/python" && export PATH="$VENV/pybin:$PATH"
rm -rf target/wheels
maturin build --release -m python/Cargo.toml -i python3 --auditwheel repair
twine check target/wheels/*.whl
mkdir -p "$SRC/target/wheels/linux"
rm -f "$SRC/target/wheels/linux/"*.whl
cp target/wheels/*.whl "$SRC/target/wheels/linux/"
ls -la "$SRC/target/wheels/linux/"
if [ "$1" = "--test" ]; then
  rm -rf "$HOME/jb-test-venv" && python3 -m venv "$HOME/jb-test-venv"
  "$HOME/jb-test-venv/bin/pip" install -q target/wheels/*.whl
  "$HOME/jb-test-venv/bin/python" python/tests/test_smoke.py
fi
