.PHONY: all build build-major build-minor install install-all-ide \
	install-code install-code-insiders install-windsurf install-cursor install-code-server \
	uninstall uninstall-code uninstall-code-insiders uninstall-windsurf uninstall-cursor uninstall-code-server \
	clean clean-vsix compile package verify-package verify publish publish-openvsx release help \
	patch-version minor-version major-version

EXT_ID := apertacodex.simple-db
EXT_NAME := simple-db
IDES := code code-insiders windsurf cursor code-server

VERSION := $(shell python3 -c "import json; print(json.load(open('package.json'))['version'])")
VSIX_FILE := $(EXT_NAME)-$(VERSION).vsix
LATEST_VSIX := $(EXT_NAME)-latest.vsix

all: build

build: clean-vsix patch-version compile package verify-package install-all
	@echo "Build completed successfully: $(LATEST_VSIX)"

build-minor: clean-vsix minor-version compile package verify-package install-all
	@echo "Build completed successfully: $(LATEST_VSIX)"

build-major: clean-vsix major-version compile package verify-package install-all
	@echo "Build completed successfully: $(LATEST_VSIX)"

install: build
install-all-ide: install-all

clean-vsix:
	@echo "Cleaning old VSIX files..."
	@rm -f ./$(EXT_NAME)-*.vsix

compile:
	@echo "Compiling TypeScript..."
	@pnpm run compile

package:
	@echo "Packaging extension..."
	@pnpm dlx @vscode/vsce package
	@rm -f ./$(LATEST_VSIX)
	@cp ./$(EXT_NAME)-$$(python3 -c "import json; print(json.load(open('package.json'))['version'])").vsix ./$(LATEST_VSIX)

verify-package:
	@echo "Verifying package contents..."
	@VSIX_SIZE=$$(stat -c%s ./$(LATEST_VSIX) 2>/dev/null || stat -f%z ./$(LATEST_VSIX)); \
	if [ $$VSIX_SIZE -lt 10000000 ]; then \
		echo "ERROR: VSIX is too small ($$VSIX_SIZE bytes). node_modules likely missing!"; \
		exit 1; \
	fi; \
	unzip -l ./$(LATEST_VSIX) | grep -q "node_modules/mongoose" || { echo "ERROR: mongoose not found!"; exit 1; }; \
	unzip -l ./$(LATEST_VSIX) | grep -q "node_modules/@vscode/sqlite3" || { echo "ERROR: @vscode/sqlite3 not found!"; exit 1; }; \
	echo "Package verification passed: $$VSIX_SIZE bytes"

install-all:
	@echo "Installing extension to available IDEs..."
	@for ide in $(IDES); do \
		if command -v $$ide >/dev/null 2>&1; then \
			echo "Installing to $$ide..."; \
			$$ide --install-extension ./$(LATEST_VSIX) --force 2>/dev/null || true; \
		fi; \
	done
	@echo "Installation completed"

install-%: build
	@$* --install-extension ./$(LATEST_VSIX) --force

uninstall:
	@echo "Uninstalling extension from available IDEs..."
	@for ide in $(IDES); do \
		if command -v $$ide >/dev/null 2>&1; then \
			echo "Uninstalling from $$ide..."; \
			$$ide --uninstall-extension $(EXT_ID) 2>/dev/null || true; \
		fi; \
	done
	@echo "Uninstallation completed"

uninstall-%:
	@$* --uninstall-extension $(EXT_ID)

patch-version:
	@$(MAKE) bump PART=patch

minor-version:
	@$(MAKE) bump PART=minor

major-version:
	@$(MAKE) bump PART=major

bump:
	@python3 -c "import json; p='package.json'; d=json.load(open(p)); v=list(map(int,d['version'].split('.'))); \
part='$(PART)'; \
v[0],v[1],v[2]=(v[0]+1,0,0) if part=='major' else (v[0],v[1]+1,0) if part=='minor' else (v[0],v[1],v[2]+1); \
d['version']='.'.join(map(str,v)); json.dump(d, open(p,'w'), indent=4); print('New version:', d['version'])"

publish:
	@echo "Publishing to VS Code Marketplace..."
	@export $$(grep -v '^#' .env | xargs) 2>/dev/null || true; \
	if [ -z "$$VSCE_PAT" ]; then \
		echo "Error: VSCE_PAT is not set"; \
		exit 1; \
	fi; \
	pnpm dlx @vscode/vsce publish -p $$VSCE_PAT

publish-openvsx:
	@echo "Publishing to OpenVSX..."
	@export $$(grep -v '^#' .env | xargs) 2>/dev/null || true; \
	if [ -z "$$OVSX_PAT" ]; then \
		echo "Error: OVSX_PAT is not set"; \
		exit 1; \
	fi; \
	pnpm dlx ovsx publish ./$(LATEST_VSIX) -p $$OVSX_PAT

release: build publish publish-openvsx
	@echo "Release completed"

verify:
	@echo "Verifying installed extensions..."
	@for ext_dir in ~/.vscode/extensions/$(EXT_ID)-* ~/.vscode-insiders/extensions/$(EXT_ID)-*; do \
		if [ -d "$$ext_dir" ]; then \
			echo "Checking $$ext_dir..."; \
			test -d "$$ext_dir/node_modules" || { echo "ERROR: node_modules missing"; exit 1; }; \
			test -d "$$ext_dir/node_modules/mongoose" || { echo "ERROR: mongoose missing"; exit 1; }; \
			test -d "$$ext_dir/node_modules/@vscode/sqlite3" || { echo "ERROR: @vscode/sqlite3 missing"; exit 1; }; \
			echo "$$ext_dir OK"; \
		fi; \
	done
	@echo "All installed extensions verified"

clean:
	@echo "Cleaning build artifacts..."
	@rm -f ./$(EXT_NAME)-*.vsix
	@rm -rf ./out ./node_modules
	@echo "Clean completed"

help:
	@echo "Available targets:"
	@echo "  build              Patch version, compile, package, verify, install all"
	@echo "  build-minor        Minor version bump, compile, package, verify, install all"
	@echo "  build-major        Major version bump, compile, package, verify, install all"
	@echo "  install-all        Install latest VSIX to available IDEs"
	@echo "  install-code       Build and install to VS Code"
	@echo "  install-cursor     Build and install to Cursor"
	@echo "  uninstall          Uninstall from all available IDEs"
	@echo "  uninstall-code     Uninstall from VS Code"
	@echo "  publish            Publish to VS Code Marketplace"
	@echo "  publish-openvsx    Publish to OpenVSX"
	@echo "  release            Build and publish to both marketplaces"
	@echo "  verify             Verify installed dependencies"
	@echo "  clean              Remove build artifacts"