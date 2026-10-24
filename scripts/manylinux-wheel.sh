#!/bin/bash
# Build the manylinux_2_28 wheel of the Python package in the PyPA manylinux container (glibc 2.28:
# RHEL/Alma/Rocky 8+, Debian 10+, Ubuntu 18.10+, Amazon Linux 2023). From the repository root:
#   docker run --rm -v "$PWD:/src:ro" -v jb-cargo:/root/.cargo -v jb-target:/work/target \
#     -v "$PWD/target/wheels/manylinux:/out" quay.io/pypa/manylinux_2_28_x86_64 bash /src/scripts/manylinux-wheel.sh
# The named volumes keep the Rust toolchain, crate downloads and build cache between runs.
set -e
export PATH=/root/.cargo/bin:$PATH
# toolchains live in the cached volume too
export RUSTUP_HOME=/root/.cargo/rustup CARGO_HOME=/root/.cargo
if ! cargo --version >/dev/null 2>&1; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
  rustup default stable
fi
# bindgen (mozjs, stylo) needs libclang; Stylo's build script runs `python`
command -v clang >/dev/null || dnf install -y -q clang clang-devel llvm-devel fontconfig-devel freetype-devel rsync >/dev/null
PY=/opt/python/cp312-cp312/bin/python
ln -sf "$PY" /usr/local/bin/python
"$PY" -m pip install -q "maturin>=1.9,<2" twine
mkdir -p /work
rsync -a --delete --exclude target --exclude _src --exclude .git --exclude '*.exe' --exclude '*.whl' /src/ /work/
cd /work
rm -rf target/wheels
"$PY" -m maturin build --release -m python/Cargo.toml -i "$PY" --compatibility manylinux_2_28 --auditwheel repair
"$PY" -m twine check target/wheels/*.whl
rm -f /out/*.whl
cp target/wheels/*.whl /out/
# smoke test on the oldest supported Python
V=/tmp/venv && /opt/python/cp39-cp39/bin/python -m venv $V && $V/bin/pip install -q /out/*.whl && $V/bin/python python/tests/test_smoke.py
ls -la /out
