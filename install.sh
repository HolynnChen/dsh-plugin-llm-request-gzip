#!/bin/sh
# Install dsh-plugin-model-request-accelerator into a DSH profile.
#
#   curl -fsSL https://raw.githubusercontent.com/HolynnChen/dsh-plugin-model-request-accelerator/main/install.sh | sh
#
# Clones the plugin next to the profile's other plugins and registers it in the
# profile's patch layer. Safe to re-run: an existing checkout is fast-forwarded
# and an already-registered entry is left alone.
#
# Environment overrides:
#   DSH_HOME     DSH home directory       (default: $HOME/.dsh)
#   DSH_PROFILE  profile to install into  (default: web)

set -eu

REPO_URL="https://github.com/HolynnChen/dsh-plugin-model-request-accelerator.git"
PLUGIN_ID="model-request-accelerator"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
TARGET_DIR="$PROFILE_DIR/plugins/$PLUGIN_ID"
ROW_NAME="./plugins/$PLUGIN_ID/lib/index.js"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -d "$PROFILE_DIR" ] || die "no profile \"$DSH_PROFILE\" at $PROFILE_DIR (set DSH_HOME / DSH_PROFILE?)"
[ -f "$PROFILE_DIR/package.json" ] || die "$PROFILE_DIR is not a dsh profile (no package.json)"
command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH"

if [ -d "$TARGET_DIR/.git" ]; then
	say "==> updating $TARGET_DIR"
	git -C "$TARGET_DIR" pull --ff-only --quiet
elif [ -e "$TARGET_DIR" ]; then
	die "$TARGET_DIR exists but is not a git checkout; remove it and re-run"
else
	say "==> cloning into $TARGET_DIR"
	mkdir -p "$(dirname "$TARGET_DIR")"
	git clone --quiet --depth 1 "$REPO_URL" "$TARGET_DIR"
fi

[ -e "$PATCH_FILE" ] || {
	say "==> creating $PATCH_FILE"
	printf '# Your patch layer for the %s profile.\n' "$DSH_PROFILE" >"$PATCH_FILE"
}

if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${PLUGIN_ID}[[:space:]]*\$" "$PATCH_FILE" 2>/dev/null; then
	say "==> $PATCH_FILE already registers $PLUGIN_ID; leaving it as is"
else
	# A pristine patch layer is comments followed by an empty array. Appending a
	# sequence entry after `[]` produces a file a YAML parser rejects — it reads one
	# document that is both an empty array and a block sequence — so the empty array
	# is removed first and the entry takes its place. Comments are left alone.
	if [ "$(sed 's/#.*$//' "$PATCH_FILE" | sed 's/^---//' | tr -d '[:space:]')" = "[]" ]; then
		say "==> $PATCH_FILE is still an empty array; replacing it with the entry"
		grep -vE '^[[:space:]]*\[\][[:space:]]*$' "$PATCH_FILE" >"$PATCH_FILE.tmp" || true
		mv "$PATCH_FILE.tmp" "$PATCH_FILE"
	fi
	say "==> registering $PLUGIN_ID in $PATCH_FILE"
	{
		printf '\n'
		printf '# Model request acceleration: request-body compression, pre-transmission of the\n'
		printf '# shared history, and a request-timing breakdown (Settings > Plugins).\n'
		printf -- '- insert:\n'
		printf '    - id: %s\n' "$PLUGIN_ID"
		printf "      name: '%s'\n" "$ROW_NAME"
	} >>"$PATCH_FILE"
fi

say ""
say "Installed into the \"$DSH_PROFILE\" profile."
say "  1. Reload your browser tab - the settings card arrives with the page's module graph."
say "  2. Open Settings > Plugins > Configuration and enable the providers you want."
say "Every provider starts disabled; confirm your gateway accepts content-encoding: br or"
say "gzip before enabling compression for the provider serving your current session."
say ""
say "Re-running this script updates an existing install: it fast-forwards the checkout and"
say "leaves your settings alone. The settings card shows the version and can update too."
