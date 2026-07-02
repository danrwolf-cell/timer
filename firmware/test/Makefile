# Host-side golden-vector tests for the C port of the pace engine + CSC parser.
#
#   make            build and run the tests against the checked-in vectors.h
#   make vectors    regenerate vectors.h from the TypeScript reference
#                   (requires node_modules at the repo root: `npm install`)
#
# -ffp-contract=off keeps double arithmetic bit-compatible with the JS
# engine (no fused multiply-add), so vector comparison tolerances stay tight.

CC ?= gcc
CFLAGS = -std=c11 -Wall -Wextra -Werror -O0 -g -ffp-contract=off
CORE = ../core

.PHONY: all test vectors clean

all: test

test: test_runner
	./test_runner

test_runner: test_main.c vectors.h $(CORE)/pace_engine.c $(CORE)/pace_engine.h $(CORE)/csc_parser.c $(CORE)/csc_parser.h $(CORE)/route_sheet.c $(CORE)/route_sheet.h
	$(CC) $(CFLAGS) -I$(CORE) test_main.c $(CORE)/pace_engine.c $(CORE)/csc_parser.c $(CORE)/route_sheet.c -o test_runner -lm

vectors:
	npx tsc -p tsconfig.json
	node build-ts/firmware/test/generate-vectors.js

clean:
	rm -rf test_runner build-ts
