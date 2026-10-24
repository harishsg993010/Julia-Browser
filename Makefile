# Common tasks. On Windows run from Git Bash (or any shell with make and sh).

FEATURES ?= screenshot,images
PY ?= py
WPT_ROOT ?= ../wpt
SUITE ?= dom
JOBS ?= 6
EXE := $(if $(filter Windows_NT,$(OS)),.exe,)

.PHONY: build build-dev test interact-check wpt wheel wheel-linux web-agent help

help:
	@echo "make build           release build (julia-browser + wpt) with --features $(FEATURES)"
	@echo "make build-dev       debug build"
	@echo "make test            cargo tests"
	@echo "make interact-check  real-site interaction scenarios"
	@echo "make wpt SUITE=dom   one Web Platform Tests suite against $(WPT_ROOT) (wpt serve)"
	@echo "make wheel           Python wheel (Windows: delvewheel)"
	@echo "make wheel-linux     Linux wheel via WSL"
	@echo "make web-agent       install the web agent into the current Python environment"

build:
	cargo build --release --features $(FEATURES) --bin julia-browser --bin wpt

build-dev:
	cargo build --features $(FEATURES) --bin julia-browser --bin wpt

test:
	cargo test --features $(FEATURES)

interact-check: build
	sh scripts/interact-check.sh target/release/julia-browser$(EXE)

wpt: build
	mkdir -p target/spot
	target/release/wpt$(EXE) run --root $(WPT_ROOT) --wptserve --filter $(SUITE) --jobs $(JOBS) --timeout 20 \
		--out target/wpt-$(subst /,_,$(SUITE)).json > target/spot/wpt-$(subst /,_,$(SUITE)).log 2>&1
	$(PY) scripts/suite-summary.py target/wpt-$(subst /,_,$(SUITE)).json

wheel:
	sh scripts/build-python-wheel.sh --test

wheel-linux:
	MSYS_NO_PATHCONV=1 wsl -e bash scripts/wsl-build-wheel.sh --test

web-agent:
	$(PY) -m pip install -e web-agent
