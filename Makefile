.PHONY: build build-major build-minor patch-version major-version minor-version install install-all-ide install-code install-code-insiders install-windsurf install-cursor install-code-server uninstall uninstall-code uninstall-code-insiders uninstall-windsurf uninstall-cursor uninstall-code-server clean publish publish-openvsx release verify

# Default target
all: build

# Get current version from package.json
VERSION = $(shell python3 -c "import json; print(json.load(open('package.json'))['version'])")
VSIX_FILE = simple-db-$(VERSION).vsix

# Patch version and build
build: clean-vsix patch-version compile package verify-package install-all
	@echo "Build completed successfully: $(VSIX_FILE)"

# Major version and build
build-major: clean-vsix major-version compile package verify-package install-all
	@echo "Build completed successfully: $(VSIX_FILE)"

# Minor version and build
build-minor: clean-vsix minor-version compile package verify-package install-all
	@echo "Build completed successfully: $(VSIX_FILE)"

# Clean old VSIX files
clean-vsix:
	@echo "Cleaning old VSIX files..."
	@rm -f ./simple-db-*.vsix

# Compile TypeScript
compile:
	@echo "Compiling TypeScript..."
	@npm run compile

# Package extension (WITHOUT --no-dependencies to include node_modules!)
package:
	@echo "Packaging extension..."
	@vsce package
	@rm -f ./simple-db-latest.vsix
	@cp ./$(VSIX_FILE) ./simple-db-latest.vsix

# Verify package includes node_modules
verify-package:
	@echo "Verifying package contents..."
	@VSIX_SIZE=$$(stat -c%s ./simple-db-latest.vsix 2>/dev/null || stat -f%z ./simple-db-latest.vsix); \
	if [ $$VSIX_SIZE -lt 10000000 ]; then \
		echo "ERROR: VSIX is too small ($$VSIX_SIZE bytes). node_modules likely missing!"; \
		echo "Expected size > 10MB for extension with dependencies."; \
		exit 1; \
	fi; \
	echo "Package size OK: $$VSIX_SIZE bytes"
	@unzip -l ./simple-db-latest.vsix | grep -q "node_modules/mongoose" || (echo "ERROR: mongoose not found in VSIX!" && exit 1)
	@unzip -l ./simple-db-latest.vsix | grep -q "node_modules/@vscode/sqlite3" || (echo "ERROR: @vscode/sqlite3 not found in VSIX!" && exit 1)
	@echo "Package verification passed!"

# Install to all available IDEs
install-all:
	@echo "Installing extension to all available IDEs..."
	@if command -v code >/dev/null 2>&1; then \
		echo "Installing to VS Code..."; \
		code --install-extension ./simple-db-latest.vsix --force 2>/dev/null || true; \
	fi
	@if command -v code-insiders >/dev/null 2>&1; then \
		echo "Installing to VS Code Insiders..."; \
		code-insiders --install-extension ./simple-db-latest.vsix --force 2>/dev/null || true; \
	fi
	@if command -v windsurf >/dev/null 2>&1; then \
		echo "Installing to Windsurf..."; \
		windsurf --install-extension ./simple-db-latest.vsix --force 2>/dev/null || true; \
	fi
	@if command -v cursor >/dev/null 2>&1; then \
		echo "Installing to Cursor..."; \
		cursor --install-extension ./simple-db-latest.vsix --force 2>/dev/null || true; \
	fi
	@if command -v code-server >/dev/null 2>&1; then \
		echo "Installing to code-server..."; \
		code-server --install-extension ./simple-db-latest.vsix --force 2>/dev/null || true; \
	fi
	@echo "Installation completed!"

# Patch version number (0.0.x)
patch-version:
	@echo "Patching version..."
	@python3 -c "import json; data=json.load(open('package.json')); v=data['version'].split('.'); v[2]=str(int(v[2])+1); data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"
	@echo "New version: $$(python3 -c "import json; print(json.load(open('package.json'))['version'])")"

# Major version number (x.0.0)
major-version:
	@echo "Bumping major version..."
	@python3 -c "import json; data=json.load(open('package.json')); v=data['version'].split('.'); v[0]=str(int(v[0])+1); v[1]='0'; v[2]='0'; data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"
	@echo "New version: $$(python3 -c "import json; print(json.load(open('package.json'))['version'])")"

# Minor version number (0.x.0)
minor-version:
	@echo "Bumping minor version..."
	@python3 -c "import json; data=json.load(open('package.json')); v=data['version'].split('.'); v[1]=str(int(v[1])+1); v[2]='0'; data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"
	@echo "New version: $$(python3 -c "import json; print(json.load(open('package.json'))['version'])")"

# Legacy install target (same as build)
install: build

# Install extension in all VS Code instances (alias)
install-all-ide: install-all

# Install to specific IDE
install-code-insiders: build
	@echo "Installing to VS Code Insiders..."
	code-insiders --install-extension ./simple-db-latest.vsix --force

install-code: build
	@echo "Installing to VS Code..."
	code --install-extension ./simple-db-latest.vsix --force

install-windsurf: build
	@echo "Installing to Windsurf..."
	windsurf --install-extension ./simple-db-latest.vsix --force

install-cursor: build
	@echo "Installing to Cursor..."
	cursor --install-extension ./simple-db-latest.vsix --force

install-code-server: build
	@echo "Installing to code-server..."
	code-server --install-extension ./simple-db-latest.vsix --force

# Uninstall extension from all VS Code instances
uninstall:
	@echo "Uninstalling extension..."
	@if command -v code-insiders >/dev/null 2>&1; then \
		echo "Uninstalling from VS Code Insiders..."; \
		code-insiders --uninstall-extension apertacodex.simple-db 2>/dev/null || true; \
	fi
	@if command -v code >/dev/null 2>&1; then \
		echo "Uninstalling from VS Code..."; \
		code --uninstall-extension apertacodex.simple-db 2>/dev/null || true; \
	fi
	@if command -v windsurf >/dev/null 2>&1; then \
		echo "Uninstalling from Windsurf..."; \
		windsurf --uninstall-extension apertacodex.simple-db 2>/dev/null || true; \
	fi
	@if command -v cursor >/dev/null 2>&1; then \
		echo "Uninstalling from Cursor..."; \
		cursor --uninstall-extension apertacodex.simple-db 2>/dev/null || true; \
	fi
	@if command -v code-server >/dev/null 2>&1; then \
		echo "Uninstalling from code-server..."; \
		code-server --uninstall-extension apertacodex.simple-db 2>/dev/null || true; \
	fi
	@echo "Extension uninstallation completed"

# Uninstall from specific IDE
uninstall-code-insiders:
	code-insiders --uninstall-extension apertacodex.simple-db

uninstall-code:
	code --uninstall-extension apertacodex.simple-db

uninstall-windsurf:
	windsurf --uninstall-extension apertacodex.simple-db

uninstall-cursor:
	cursor --uninstall-extension apertacodex.simple-db

uninstall-code-server:
	code-server --uninstall-extension apertacodex.simple-db

# Publish to VS Code Marketplace
publish:
	@echo "Publishing extension to VS Code Marketplace..."
	@export $$(grep -v '^#' .env | xargs) 2>/dev/null || true; \
	if [ -z "$$VSCE_PAT" ]; then \
		echo "Error: VSCE_PAT environment variable is not set"; \
		echo "Set it in .env file or export it in your shell"; \
		exit 1; \
	fi; \
	vsce publish -p $$VSCE_PAT
	@echo "Extension published to VS Code Marketplace successfully"

# Publish to OpenVSX
publish-openvsx:
	@echo "Publishing extension to OpenVSX..."
	@export $$(grep -v '^#' .env | xargs) 2>/dev/null || true; \
	if [ -z "$$OVSX_PAT" ]; then \
		echo "Error: OVSX_PAT environment variable is not set"; \
		echo "Set it in .env file or export it in your shell"; \
		exit 1; \
	fi; \
	npx ovsx publish ./simple-db-latest.vsix -p $$OVSX_PAT
	@echo "Extension published to OpenVSX successfully"

# Release to both VS Code Marketplace and OpenVSX
release: build publish publish-openvsx
	@echo "Release completed!"

# Verify installed extension has all dependencies
verify:
	@echo "Verifying installed extensions..."
	@for ext_dir in ~/.vscode/extensions/apertacodex.simple-db-* ~/.vscode-insiders/extensions/apertacodex.simple-db-*; do \
		if [ -d "$$ext_dir" ]; then \
			echo "Checking $$ext_dir..."; \
			if [ ! -d "$$ext_dir/node_modules" ]; then \
				echo "ERROR: node_modules missing in $$ext_dir"; \
				exit 1; \
			fi; \
			if [ ! -d "$$ext_dir/node_modules/mongoose" ]; then \
				echo "ERROR: mongoose missing in $$ext_dir"; \
				exit 1; \
			fi; \
			if [ ! -d "$$ext_dir/node_modules/@vscode/sqlite3" ]; then \
				echo "ERROR: @vscode/sqlite3 missing in $$ext_dir"; \
				exit 1; \
			fi; \
			echo "$$ext_dir OK!"; \
		fi; \
	done
	@echo "All installed extensions verified!"

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -f ./simple-db-*.vsix
	rm -rf ./out
	@echo "Clean completed"

# Help
help:
	@echo "Available targets:"
	@echo "  build                  - Clean, patch version, compile, package, verify, and install"
	@echo "  build-major            - Same as build but increments major version (x.0.0)"
	@echo "  build-minor            - Same as build but increments minor version (0.x.0)"
	@echo "  install                - Alias for build"
	@echo "  install-all-ide        - Install to all available IDEs"
	@echo "  install-code           - Build and install to VS Code only"
	@echo "  install-code-insiders  - Build and install to VS Code Insiders only"
	@echo "  install-windsurf       - Build and install to Windsurf only"
	@echo "  install-cursor         - Build and install to Cursor only"
	@echo "  install-code-server    - Build and install to code-server only"
	@echo "  uninstall              - Uninstall from all available IDEs"
	@echo "  publish                - Publish to VS Code Marketplace"
	@echo "  publish-openvsx        - Publish to OpenVSX"
	@echo "  release                - Build and publish to both marketplaces"
	@echo "  verify                 - Verify installed extensions have all dependencies"
	@echo "  clean                  - Remove build artifacts"
	@echo "  help                   - Show this help message"
