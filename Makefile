# Convenience wrappers around the npm scripts.

.PHONY: all install build typecheck test bench vectors serve clean help

all: build test

install:
	npm install

build:
	npm run build

typecheck:
	npm run typecheck

test: build
	npm test

bench: build
	npm run bench

# Copy the conformance vectors from ../btoon-core (other path: npm run vectors:sync -- <file>).
vectors:
	npm run vectors:sync

# Serve the repository so the browser example can load dist/esm over HTTP.
serve: build
	@echo "Open http://localhost:8080/examples/"
	python3 -m http.server 8080

clean:
	rm -rf dist

help:
	@echo "make install    install dev dependencies"
	@echo "make build      build dist/esm and dist/cjs"
	@echo "make typecheck  type-check the sources"
	@echo "make test       build, then run the test suite"
	@echo "make bench      build, then run the benchmark"
	@echo "make vectors    re-copy the conformance vectors from btoon-core"
	@echo "make serve      serve the browser example on http://localhost:8080/examples/"
	@echo "make clean      remove dist/"
