PLUGIN_ID := io.github.dpsk.layout-memory
PLUGIN_DIR := $(HOME)/.config/omarchy/plugins/$(PLUGIN_ID)
QMLLINT := $(firstword $(wildcard /usr/lib/qt6/bin/qmllint) $(shell command -v qmllint 2>/dev/null))

.PHONY: test lint validate check dev

test:
	node --test test/

lint:
	node --check LayoutMemoryModel.js
	@if [ -n "$(QMLLINT)" ]; then $(QMLLINT) Service.qml; else echo "qmllint not found, skipping"; fi

validate:
	omarchy-plugin-validate .

check: test lint validate

# Copy the working tree over an installed copy; omarchy-shell reloads it.
dev:
	@test -d "$(PLUGIN_DIR)" || { echo "Install first: omarchy plugin add $(CURDIR) --enable"; exit 1; }
	rsync -a --delete --exclude .git ./ "$(PLUGIN_DIR)/"
