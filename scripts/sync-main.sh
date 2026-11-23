#!/usr/bin/env bash
# TransPrice — publish both branches: push `dev`, then rebuild `main` (the product branch) from dev's
# committed tree minus every path listed in .mainignore, and push `main`.
#
#   npm run sync:main            # run from the dev branch with a clean working tree
#   npm run sync:main -- --local # rebuild the local `main` only, never push (also automatic without `origin`)
#
# `main` is generated — never commit to it by hand. Each sync adds one commit on main that mirrors dev@<sha>
# (nothing is committed when main already matches).
#
# How: dev's committed tree is exported to a temp dir (`git archive`), the .mainignore paths are deleted there with
# bash globbing, and the result is written as a tree through a throw-away index (`GIT_INDEX_FILE`) and committed with
# `git commit-tree` on top of main. No worktree and no checkout are involved, so it works on any git ≥ 2.20 (macOS
# ships 2.39, which lacks `git worktree add --orphan`) and never touches your working tree or index.
#
# Without an `origin` remote it only rebuilds the local `main` branch and prints how to add the remote.
set -euo pipefail

LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local | --no-push) LOCAL_ONLY=1 ;;
    -h | --help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "✖ Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "dev" ]; then
  echo "✖ Run this from the dev branch (current: ${BRANCH:-detached})." >&2
  exit 1
fi
if ! git rev-parse -q --verify HEAD >/dev/null; then
  echo "✖ dev has no commits yet — commit first." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✖ Uncommitted changes — commit (or stash) them on dev first." >&2
  exit 1
fi
if ! git cat-file -e HEAD:.mainignore 2>/dev/null; then
  echo "✖ .mainignore is not committed on dev." >&2
  exit 1
fi
# update-ref on a branch that is checked out elsewhere would leave that worktree out of date.
if git worktree list --porcelain | grep -qx 'branch refs/heads/main'; then
  echo "✖ main is checked out in another worktree ($(git worktree list | awk '/\[main\]/ { print $1 }')) — switch it away first." >&2
  exit 1
fi

HAS_ORIGIN=0
git remote get-url origin >/dev/null 2>&1 && HAS_ORIGIN=1
PUSH=$((HAS_ORIGIN && !LOCAL_ONLY))

DEV_SHA="$(git rev-parse --short HEAD)"
DEV_SUBJECT="$(git log -1 --pretty=%s)"
DEV_TRAILERS="$(git log -1 --pretty='%(trailers:only,unfold)')"

if [ "$PUSH" = 1 ]; then
  echo "▶ Pushing dev (${DEV_SHA})"
  git push -u origin dev
  git fetch -q origin main 2>/dev/null || true
elif [ "$HAS_ORIGIN" = 0 ]; then
  echo "• No 'origin' remote — rebuilding the local main branch only (nothing is pushed)."
else
  echo "• --local — rebuilding the local main branch only (nothing is pushed)."
fi

# Parent of the new main commit: the published main if there is one, else the local main, else none (root commit).
PARENT=""
if [ "$PUSH" = 1 ] && git show-ref -q --verify refs/remotes/origin/main; then
  PARENT="$(git rev-parse refs/remotes/origin/main)"
elif git show-ref -q --verify refs/heads/main; then
  PARENT="$(git rev-parse refs/heads/main)"
fi
OLD_MAIN="$(git rev-parse -q --verify refs/heads/main || true)"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
TREE_DIR="$TMP/tree"
mkdir -p "$TREE_DIR"

# 1. dev's committed tree…
git archive --format=tar HEAD | tar -x -C "$TREE_DIR"

# 2. …minus the dev-only paths (one path or bash glob per line; comments and blank lines ignored).
git show HEAD:.mainignore > "$TMP/mainignore"
(
  cd "$TREE_DIR"
  shopt -s nullglob dotglob # (no globstar: macOS ships bash 3.2)
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    case "$line" in
      /* | ..* | */..* | . | ./)
        echo "⚠ .mainignore: skipping unsafe entry \"$line\" (use paths relative to the repo root)" >&2
        continue
        ;;
    esac
    for path in $line; do
      rm -rf -- "$path"
    done
  done < "$TMP/mainignore"
)

# Safety net: never publish a main without the product.
for required in extension/manifest.json README.md LICENSE; do
  if [ ! -e "$TREE_DIR/$required" ]; then
    echo "✖ $required would be missing from main — is it listed in .mainignore (or not committed)? Aborting." >&2
    exit 1
  fi
done

# 3. Write the tree through a throw-away index (-f: keep files that dev committed even if .gitignore matches them).
GIT_DIR_ABS="$(git rev-parse --absolute-git-dir)"
TREE="$(
  cd "$TREE_DIR"
  export GIT_DIR="$GIT_DIR_ABS" GIT_WORK_TREE="$TREE_DIR" GIT_INDEX_FILE="$TMP/index"
  git add -A -f .
  git write-tree
)"

if [ -n "$PARENT" ] && [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  NEW_MAIN="$PARENT"
  echo "✔ main is already in sync with dev@${DEV_SHA}"
else
  MSG="Sync from dev@${DEV_SHA}: ${DEV_SUBJECT}"
  BODY="Product build of dev (guides, demos, tests and tooling removed — see .mainignore on dev)."
  ARGS=(-m "$MSG" -m "$BODY")
  [ -n "$DEV_TRAILERS" ] && ARGS+=(-m "$DEV_TRAILERS")
  if [ -n "$PARENT" ]; then
    NEW_MAIN="$(git commit-tree "$TREE" -p "$PARENT" "${ARGS[@]}")"
  else
    NEW_MAIN="$(git commit-tree "$TREE" "${ARGS[@]}")"
  fi
  echo "✔ dev@${DEV_SHA} → main@$(git rev-parse --short "$NEW_MAIN") ($(git ls-tree -r --name-only "$NEW_MAIN" | wc -l | tr -d ' ') files)"
fi

if [ "$NEW_MAIN" != "$OLD_MAIN" ]; then
  git update-ref -m "sync-main: dev@${DEV_SHA}" refs/heads/main "$NEW_MAIN" ${OLD_MAIN:+"$OLD_MAIN"}
fi

if [ "$PUSH" = 1 ]; then
  if [ "$(git rev-parse -q --verify refs/remotes/origin/main || true)" != "$NEW_MAIN" ]; then
    echo "▶ Pushing main"
    git push origin main
  else
    echo "✔ origin/main is up to date"
  fi
elif [ "$HAS_ORIGIN" = 0 ]; then
  cat <<'EOF'

Hint: publish both branches once the GitHub repository exists:
  git remote add origin https://github.com/PhamTienThanhCong/transprice.git
  npm run sync:main
EOF
fi
