#!/bin/sh
# Build the Windows wheel of the Python package (python/) and bundle the MSVC C++ runtime into it.
#   sh scripts/build-python-wheel.sh            -> target/wheels/repaired/julia_browser-*.whl
#   sh scripts/build-python-wheel.sh --test     -> also installs it in a fresh venv and runs the smoke tests
# Upload (needs a PyPI API token):  py -m twine upload target/wheels/repaired/*.whl
set -e
PY=${PY:-/c/Users/haris/Python311/python.exe}
cd "$(dirname "$0")/.."
rm -rf target/wheels/*.whl target/wheels/repaired target/wheels/venv
"$PY" -m pip install -q "maturin>=1.9,<2" delvewheel twine
# Stylo's build script needs `python` on PATH
PATH="$(dirname "$PY"):$PATH" "$PY" -m maturin build --release -m python/Cargo.toml -i "$PY"
# MSVCP140.dll is not shipped with Python; vendor it so the wheel imports without the VC++ redistributable
# webauthn.dll is the Windows FIDO API (security keys, src/js/passkeys.rs): a system DLL, never vendored
"$PY" -m delvewheel repair --add-dll msvcp140.dll --no-dll webauthn.dll -w target/wheels/repaired target/wheels/julia_browser-*.whl
"$PY" -m twine check target/wheels/repaired/*.whl
if [ "$1" = "--test" ]; then
  V=target/wheels/venv
  "$PY" -m venv "$V"
  "$V/Scripts/python.exe" -m pip install -q target/wheels/repaired/*.whl
  "$V/Scripts/python.exe" python/tests/test_smoke.py
fi
