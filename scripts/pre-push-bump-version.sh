#!/bin/sh
# Bump app version, commit, and push including the bump.
# Aborts the original push after a successful re-push (so the bump commit is included).
# Skip with: WORKEE_SKIP_VERSION_BUMP=1 git push
set -e

if [ "${WORKEE_SKIP_VERSION_BUMP}" = "1" ]; then
  exit 0
fi

remote="$1"
if [ -z "$remote" ]; then
  remote="origin"
fi

zero="0000000000000000000000000000000000000000"
should_bump=0
while read -r local_ref local_sha remote_ref remote_sha || [ -n "${local_ref:-}" ]
do
  [ -z "${local_ref:-}" ] && continue
  case "$local_ref" in
    refs/heads/*)
      if [ "$local_sha" != "$zero" ] && [ "$local_sha" != "$remote_sha" ]; then
        should_bump=1
      fi
      ;;
  esac
  local_ref=""
done

# Some tooling invokes pre-push with an empty stdin — fall back to ahead-of-upstream.
if [ "$should_bump" != "1" ]; then
  if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    ahead="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
    if [ "${ahead:-0}" -gt 0 ]; then
      should_bump=1
    fi
  fi
fi

if [ "$should_bump" != "1" ]; then
  exit 0
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "pre-push: node not found; skipping version bump" >&2
  exit 0
fi

next="$(node "$root/scripts/bump-version.mjs")"
git add VERSION frontend/src/version.ts

if git diff --cached --quiet; then
  exit 0
fi

# Prefer existing repo identity; fall back so the hook still works in sandboxes.
git -c user.useConfigOnly=false commit -m "chore: bump version to ${next}" || \
  git -c user.name='Amit Hatan' -c user.email='amit.hatan@gmail.com' commit -m "chore: bump version to ${next}"

branch="$(git rev-parse --abbrev-ref HEAD)"
echo "pre-push: bumped to ${next}; pushing ${branch} (includes version commit)…" >&2
WORKEE_SKIP_VERSION_BUMP=1 git push "$remote" "HEAD:refs/heads/${branch}"
echo "pre-push: pushed ${branch} at version ${next}" >&2
# Cancel the original push — refs on stdin are already behind the bump commit.
exit 1
