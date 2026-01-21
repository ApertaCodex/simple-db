.PHONY: build build-major build-minor patch-version major-version minor-version install install-all-ide install-code install-code-insiders install-windsurf install-cursor install-code-server uninstall uninstall-code uninstall-code-insiders uninstall-windsurf uninstall-cursor uninstall-code-server clean publish

# Default target
all: build

# Patch version and build
build: patch-version
	pnpm run compile && vsce package --no-dependencies
	@echo "Creating latest version package..."
	@rm -rf ./simple-db-latest.vsix
	@cp ./simple-db-$(shell python3 -c "import json; print(json.load(open('package.json'))['version'])").vsix ./simple-db-latest.vsix

# Major version and build
build-major: major-version
	pnpm run compile && vsce package --no-dependencies
	@echo "Creating latest version package..."
	@rm -rf ./simple-db-latest.vsix
	@cp ./simple-db-$(shell python3 -c "import json; print(json.load(open('package.json'))['version'])").vsix ./simple-db-latest.vsix

# Minor version and build
build-minor: minor-version
	pnpm run compile && vsce package --no-dependencies
	@echo "Creating latest version package..."
	@rm -rf ./simple-db-latest.vsix
	@cp ./simple-db-$(shell python3 -c "import json; print(json.load(open('package.json'))['version'])").vsix ./simple-db-latest.vsix

# Patch version number (0.0.x)
patch-version:
	@echo "Patching version..."
	@python3 -c "import json; import sys; data=json.load(open('package.json')); v=data['version'].split('.'); v[2]=str(int(v[2])+1); data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"

# Major version number (x.0.0)
major-version:
	@echo "Bumping major version..."
	@python3 -c "import json; import sys; data=json.load(open('package.json')); v=data['version'].split('.'); v[0]=str(int(v[0])+1); v[1]='0'; v[2]='0'; data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"

# Minor version number (0.x.0)
minor-version:
	@echo "Bumping minor version..."
	@python3 -c "import json; import sys; data=json.load(open('package.json')); v=data['version'].split('.'); v[1]=str(int(v[1])+1); v[2]='0'; data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"

# Install extension in all VS Code instances
install: build
	@echo "Installing extension..."
	@if command -v code-insiders >/dev/null 2>&1; then \
		echo "Installing to VS Code Insiders..."; \
		code-insiders --uninstall-extension simple-db.simple-db 2>/dev/null || true; \
		code-insiders --install-extension ./simple-db-latest.vsix --force; \
	fi
	@if command -v code >/dev/null 2>&1; then \
		echo "Installing to VS Code..."; \
		code --uninstall-extension simple-db.simple-db 2>/dev/null || true; \
		code --install-extension ./simple-db-latest.vsix --force; \
	fi
	@if command -v windsurf >/dev/null 2>&1; then \
		echo "Installing to Windsurf..."; \
		windsurf --uninstall-extension simple-db.simple-db 2>/dev/null || true; \
		windsurf --install-extension ./simple-db-latest.vsix --force; \
	fi
	@if command -v cursor >/dev/null 2>&1; then \
		echo "Installing to Cursor..."; \
		cursor --uninstall-extension simple-db.simple-db 2>/dev/null || true; \
		cursor --install-extension ./simple-db-latest.vsix --force; \
	fi
	@if command -v code-server >/dev/null 2>&1; then \
		echo "Installing to code-server..."; \
		code-server --uninstall-extension simple-db.simple-db 2>/dev/null || true; \
		code-server --install-extension ./simple-db-latest.vsix --force; \
	fi
	@echo "Extension installation completed for available IDEs"

# Install extension in all IDEs (alias for install)
install-all-ide: install

# Install to specific IDE
install-code-insiders: build
	@echo "Installing to VS Code Insiders..."
	code-insiders --uninstall-extension simple-db.simple-db 2>/dev/null || true
	code-insiders --install-extension ./simple-db-latest.vsix --force

install-code: build
	@echo "Installing to VS Code..."
	code --uninstall-extension simple-db.simple-db 2>/dev/null || true
	code --install-extension ./simple-db-latest.vsix --force

install-windsurf: build
	@echo "Installing to Windsurf..."
	windsurf --uninstall-extension simple-db.simple-db 2>/dev/null || true
	windsurf --install-extension ./simple-db-latest.vsix --force

install-cursor: build
	@echo "Installing to Cursor..."
	cursor --uninstall-extension simple-db.simple-db 2>/dev/null || true
	cursor --install-extension ./simple-db-latest.vsix --force

install-code-server: build
	@echo "Installing to code-server..."
	code-server --uninstall-extension simple-db.simple-db 2>/dev/null || true
	code-server --install-extension ./simple-db-latest.vsix --force

# Uninstall extension from all VS Code instances
uninstall:
	@echo "Uninstalling extension..."
	@if command -v code-insiders >/dev/null 2>&1; then \
		echo "Uninstalling from VS Code Insiders..."; \
		code-insiders --uninstall-extension simple-db.simple-db; \
	fi
	@if command -v code >/dev/null 2>&1; then \
		echo "Uninstalling from VS Code..."; \
		code --uninstall-extension simple-db.simple-db; \
	fi
	@if command -v windsurf >/dev/null 2>&1; then \
		echo "Uninstalling from Windsurf..."; \
		windsurf --uninstall-extension simple-db.simple-db; \
	fi
	@if command -v cursor >/dev/null 2>&1; then \
		echo "Uninstalling from Cursor..."; \
		cursor --uninstall-extension simple-db.simple-db; \
	fi
	@if command -v code-server >/dev/null 2>&1; then \
		echo "Uninstalling from code-server..."; \
		code-server --uninstall-extension simple-db.simple-db; \
	fi
	@echo "Extension uninstallation completed for available IDEs"

# Uninstall from specific IDE
uninstall-code-insiders:
	@echo "Uninstalling from VS Code Insiders..."
	code-insiders --uninstall-extension simple-db.simple-db

uninstall-code:
	@echo "Uninstalling from VS Code..."
	code --uninstall-extension simple-db.simple-db

uninstall-windsurf:
	@echo "Uninstalling from Windsurf..."
	windsurf --uninstall-extension simple-db.simple-db

uninstall-cursor:
	@echo "Uninstalling from Cursor..."
	cursor --uninstall-extension simple-db.simple-db

uninstall-code-server:
	@echo "Uninstalling from code-server..."
	code-server --uninstall-extension simple-db.simple-db

# Publish to VS Code Marketplace
publish:
	@echo "Publishing extension to VS Code Marketplace..."
	vsce publish --no-dependencies
	@echo "Extension published successfully"

release: build publish
# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -f ./simple-db-*.vsix
	rm -f ./simple-db-latest.vsix
	rm -rf ./out
	@echo "Clean completed"

# Help
help:
	@echo "Available targets:"
	@echo "  build                  - Patch version and build extension (0.0.x)"
	@echo "  build-major            - Major version and build extension (x.0.0)"
	@echo "  build-minor            - Minor version and build extension (0.x.0)"
	@echo "  patch-version          - Increment patch version number (0.0.x)"
	@echo "  major-version          - Increment major version number (x.0.0)"
	@echo "  minor-version          - Increment minor version number (0.x.0)"
	@echo "  install                - Build and install in all available IDEs"
	@echo "                          (VS Code, VS Code Insiders, Windsurf, Cursor, code-server)"
	@echo "  install-all-ide        - Build and install in all available IDEs (alias for install)"
	@echo "  install-code           - Build and install to VS Code only"
	@echo "  install-code-insiders  - Build and install to VS Code Insiders only"
	@echo "  install-windsurf       - Build and install to Windsurf only"
	@echo "  install-cursor         - Build and install to Cursor only"
	@echo "  install-code-server    - Build and install to code-server only"
	@echo "  uninstall              - Uninstall from all available IDEs"
	@echo "  uninstall-code         - Uninstall from VS Code only"
	@echo "  uninstall-code-insiders- Uninstall from VS Code Insiders only"
	@echo "  uninstall-windsurf     - Uninstall from Windsurf only"
	@echo "  uninstall-cursor       - Uninstall from Cursor only"
	@echo "  uninstall-code-server  - Uninstall from code-server only"
	@echo "  publish                - Build and publish to VS Code Marketplace"
	@echo "  clean                  - Remove build artifacts"
	@echo "  help                   - Show this help message"
