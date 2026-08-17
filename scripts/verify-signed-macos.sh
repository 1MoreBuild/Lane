#!/bin/bash
set -euo pipefail

expected_team_id=${APPLE_TEAM_ID:?APPLE_TEAM_ID is required for release verification}
release_version=$(node -p "require('./package.json').version")
app_paths=(
  release/mac/Lane.app
  release/mac-arm64/Lane.app
)

for app_path in "${app_paths[@]}"; do
  if [[ ! -d "$app_path" ]]; then
    echo "Expected release app is missing: $app_path" >&2
    exit 1
  fi
  echo "Verifying $app_path"

  codesign --verify --deep --strict --verbose=2 "$app_path"
  signature_details=$(codesign --display --verbose=4 "$app_path" 2>&1)
  grep -Fq "Identifier=works.earendil.lane" <<<"$signature_details"
  grep -Fq "Authority=Developer ID Application:" <<<"$signature_details"
  grep -Fq "TeamIdentifier=$expected_team_id" <<<"$signature_details"
  grep -Eq "flags=.*runtime" <<<"$signature_details"

  entitlements_file=$(mktemp)
  trap 'rm -f "$entitlements_file"' EXIT
  codesign --display --entitlements :- "$app_path" >"$entitlements_file" 2>/dev/null
  for entitlement in \
    com.apple.security.cs.allow-jit \
    com.apple.security.cs.allow-unsigned-executable-memory; do
    entitlement_value=$(/usr/libexec/PlistBuddy \
      -c "Print :$entitlement" "$entitlements_file" 2>/dev/null || true)
    if [[ "$entitlement_value" != "true" ]]; then
      echo "Release app is missing required entitlement: $entitlement" >&2
      exit 1
    fi
  done
  # The signed release shares one Team ID, so library validation must stay on;
  # only ad-hoc test bundles are signed with the entitlement that relaxes it.
  if library_validation=$(/usr/libexec/PlistBuddy \
    -c "Print :com.apple.security.cs.disable-library-validation" \
    "$entitlements_file" 2>/dev/null); then
    if [[ "$library_validation" == "true" ]]; then
      echo "Release app must not disable library validation" >&2
      exit 1
    fi
  fi
  if get_task_allow=$(/usr/libexec/PlistBuddy \
    -c "Print :com.apple.security.get-task-allow" "$entitlements_file" 2>/dev/null); then
    if [[ "$get_task_allow" == "true" ]]; then
      echo "Release app contains the debug-only get-task-allow entitlement" >&2
      exit 1
    fi
  fi
  rm -f "$entitlements_file"
  trap - EXIT

  spctl --assess --type execute --verbose=4 "$app_path"
  xcrun stapler validate "$app_path"
done

dmg_paths=(
  "release/Lane-$release_version-mac-arm64.dmg"
  "release/Lane-$release_version-mac-x64.dmg"
)

for dmg_path in "${dmg_paths[@]}"; do
  if [[ ! -f "$dmg_path" ]]; then
    echo "Expected release DMG is missing: $dmg_path" >&2
    exit 1
  fi
  echo "Verifying $dmg_path"
  xcrun stapler validate "$dmg_path"

  mount_dir=$(mktemp -d)
  cleanup_mount() {
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
    rmdir "$mount_dir" >/dev/null 2>&1 || true
  }
  trap cleanup_mount EXIT
  hdiutil attach "$dmg_path" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null

  dmg_app="$mount_dir/Lane.app"
  if [[ ! -d "$dmg_app" ]]; then
    echo "Lane.app is missing from release DMG: $dmg_path" >&2
    exit 1
  fi
  codesign --verify --deep --strict --verbose=2 "$dmg_app"
  spctl --assess --type execute --verbose=4 "$dmg_app"
  xcrun stapler validate "$dmg_app"

  cleanup_mount
  trap - EXIT
done

test -f release/latest-mac.yml
grep -Eq 'url: Lane-.*-mac-arm64\.zip' release/latest-mac.yml
grep -Eq 'url: Lane-.*-mac-x64\.zip' release/latest-mac.yml
