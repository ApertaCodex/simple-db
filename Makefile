.PHONY: build patch-version install install-code install-code-insiders install-windsurf install-cursor install-code-server clean publish

# Default target
all: build

# Patch version and build
build: patch-version
	npm run compile && vsce package

# Patch version number
patch-version:
	@echo "Patching version..."
	@python3 -c "import json; import sys; data=json.load(open('package.json')); v=data['version'].split('.'); v[2]=str(int(v[2])+1); data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"

# Install extension in all VS Code instances
install: build
	@echo "Installing extension..."
	@if command -v code-insiders >/dev/null 2>&1; then \
		echo "Installing to VS Code Insiders..."; \
		code-insiders --install-extension ./database-viewer-*.vsix --force; \
	fi
	@if command -v code >/dev/null 2>&1; then \
		echo "Installing to VS Code..."; \
		code --install-extension ./database-viewer-*.vsix --force; \
	fi
	@if command -v windsurf >/dev/null 2>&1; then \
		echo "Installing to Windsurf..."; \
		windsurf --install-extension ./database-viewer-*.vsix --force; \
	fi
	@if command -v cursor >/dev/null 2>&1; then \
		echo "Installing to Cursor..."; \
		cursor --install-extension ./database-viewer-*.vsix --force; \
	fi
	@if command -v code-server >/dev/null 2>&1; then \
		echo "Installing to code-server..."; \
		code-server --install-extension ./database-viewer-*.vsix --force; \
	fi
	@echo "Extension installation completed for available IDEs"

# Install to specific IDE
install-code-insiders: build
	@echo "Installing to VS Code Insiders..."
	code-insiders --install-extension ./database-viewer-*.vsix --force

install-code: build
	@echo "Installing to VS Code..."
	code --install-extension ./database-viewer-*.vsix --force

install-windsurf: build
	@echo "Installing to Windsurf..."
	windsurf --install-extension ./database-viewer-*.vsix --force

install-cursor: build
	@echo "Installing to Cursor..."
	cursor --install-extension ./database-viewer-*.vsix --force

install-code-server: build
	@echo "Installing to code-server..."
	code-server --install-extension ./database-viewer-*.vsix --force

# Publish to VS Code Marketplace
publish: build
	@echo "Publishing extension to VS Code Marketplace..."
	vsce publish
	@echo "Extension published successfully"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -f ./database-viewer-*.vsix
	rm -rf ./out
	@echo "Clean completed"

# Help
help:
	@echo "Available targets:"
	@echo "  build                  - Patch version and build extension"
	@echo "  patch-version          - Increment patch version number"
	@echo "  install                - Build and install in all available IDEs"
	@echo "                          (VS Code, VS Code Insiders, Windsurf, Cursor, code-server)"
	@echo "  install-code           - Build and install to VS Code only"
	@echo "  install-code-insiders  - Build and install to VS Code Insiders only"
	@echo "  install-windsurf       - Build and install to Windsurf only"
	@echo "  install-cursor         - Build and install to Cursor only"
	@echo "  install-code-server    - Build and install to code-server only"
	@echo "  publish                - Build and publish to VS Code Marketplace"
	@echo "  clean                  - Remove build artifacts"
	@echo "  help                   - Show this help message"
