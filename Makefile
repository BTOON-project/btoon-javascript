# Makefile for BTOON JavaScript/WebAssembly library

.PHONY: all build clean test install help

# Commands
NPM := npm
EMCC := emcc

# Default target
all: build

# Install dependencies
install:
	@echo "Installing dependencies..."
	@$(NPM) install

# Build WebAssembly module
wasm:
	@echo "Building WebAssembly module..."
	@mkdir -p wasm
	@if command -v $(EMCC) >/dev/null 2>&1; then \
		$(EMCC) src/btoon_wasm.cpp \
			-I../btoon-core/include \
			-o wasm/btoon.js \
			-s MODULARIZE=1 \
			-s EXPORT_NAME="BTOONModule" \
			-s WASM=1 \
			-s ALLOW_MEMORY_GROWTH=1 \
			-s EXPORTED_FUNCTIONS="['_malloc','_free','_btoon_encode','_btoon_decode']" \
			-O3; \
		echo "WebAssembly module built successfully!"; \
	else \
		echo "Warning: Emscripten not found. Skipping WASM build."; \
		echo "Install from: https://emscripten.org/docs/getting_started/downloads.html"; \
	fi

# Build JavaScript bundle
js:
	@echo "Building JavaScript bundle..."
	@$(NPM) run build:js

# Build everything
build: install wasm js
	@echo "Building complete package..."
	@$(NPM) run build:prod
	@echo "✅ Build complete!"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf dist/ build/ wasm/*.wasm wasm/*.js coverage/ .cache/
	@rm -rf node_modules package-lock.json

# Run tests
test: build
	@echo "Running tests..."
	@$(NPM) test

# Run browser tests
test-browser: build
	@echo "Running browser tests..."
	@$(NPM) run test:browser

# Run linter
lint:
	@echo "Linting code..."
	@$(NPM) run lint

# Format code
format:
	@echo "Formatting code..."
	@$(NPM) run format

# Development mode with watch
dev:
	@echo "Starting development mode..."
	@$(NPM) run dev

# Serve examples
serve: build
	@echo "Starting local server..."
	@echo "Open http://localhost:8080/examples/ in your browser"
	@$(NPM) run serve

# Build for production
prod: clean build test
	@echo "Building for production..."
	@$(NPM) run build:prod

# Create distribution package
dist: prod
	@echo "Creating distribution package..."
	@$(NPM) pack
	@echo "Package created: btoon-js-*.tgz"

# Publish to npm
publish: dist
	@echo "Publishing to npm..."
	@$(NPM) publish

# Size analysis
size: build
	@echo "Bundle size analysis:"
	@echo "===================="
	@ls -lh dist/ | grep -E '\.(js|wasm)'
	@echo ""
	@echo "Gzipped sizes:"
	@for file in dist/*.js; do \
		if [ -f "$$file" ]; then \
			gzip -c "$$file" | wc -c | xargs echo "$$(basename $$file):"; \
		fi \
	done

# Run benchmarks
bench: build
	@echo "Running benchmarks..."
	@node benchmarks/benchmark.js

# Check for updates
update-deps:
	@echo "Checking for dependency updates..."
	@npx npm-check-updates

# Security audit
security:
	@echo "Running security audit..."
	@$(NPM) audit

# Documentation
docs:
	@echo "Generating documentation..."
	@npx jsdoc -c jsdoc.json

# Quick test
test-quick: build
	@echo "Running quick test..."
	@node examples/node-test.js

# Install globally for CLI usage
global:
	@echo "Installing globally..."
	@$(NPM) install -g .

# Help
help:
	@echo "BTOON JavaScript/WebAssembly Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  make install     - Install dependencies"
	@echo "  make build       - Build the library"
	@echo "  make wasm        - Build WebAssembly module only"
	@echo "  make js          - Build JavaScript bundle only"
	@echo "  make clean       - Clean build artifacts"
	@echo "  make test        - Run tests"
	@echo "  make test-browser- Run browser tests"
	@echo "  make lint        - Run linter"
	@echo "  make format      - Format code"
	@echo "  make dev         - Start development mode"
	@echo "  make serve       - Serve examples locally"
	@echo "  make prod        - Production build"
	@echo "  make dist        - Create package"
	@echo "  make publish     - Publish to npm"
	@echo "  make size        - Analyze bundle size"
	@echo "  make bench       - Run benchmarks"
	@echo "  make security    - Security audit"
	@echo "  make docs        - Generate documentation"
	@echo "  make help        - Show this help"
