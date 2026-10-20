#!/bin/sh
# Install pre-push (version bump) and keep any existing post-push alone.
set -e
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$root"

common_dir="$(git rev-parse --git-common-dir)"
case "$common_dir" in
  /*) ;;
  *) common_dir="$root/$common_dir" ;;
esac
hooks_dir="$common_dir/hooks"
mkdir -p "$hooks_dir"

pre_push="$hooks_dir/pre-push"
cp "$root/scripts/pre-push-bump-version.sh" "$pre_push"
chmod +x "$pre_push" "$root/scripts/pre-push-bump-version.sh" "$root/scripts/bump-version.mjs"

echo "Installed pre-push hook: $pre_push"
echo "Every git push bumps VERSION (skip with WORKEE_SKIP_VERSION_BUMP=1)."
