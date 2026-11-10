#!/bin/sh
# HarnessHub GitHub Release installer. Generated releases replace the version below.
set -eu
umask 077
VERSION='@HHU_VERSION@'
REPOSITORY='HalaRank/HarnessHub'
fail() { echo "HarnessHub: $*" >&2; exit 1; }
for tool in uname getconf tar gzip sha256sum awk mktemp flock git dirname basename cp rm; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required system tool is missing: $tool"
done
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'Only Linux x64 / WSL2 is supported.'
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'This package requires glibc; Alpine/musl is not supported.'
case "$VERSION" in *@*) fail 'Use install.sh from a built GitHub Release, not the source template.' ;; esac
ARCHIVE="harnesshub-$VERSION-linux-x64.tar.gz"
archive=''
case "${1-}" in
  --archive) [ "$#" = 2 ] || fail 'Usage: install.sh [--archive /path/to/package.tar.gz]'; archive=$2 ;;
  '') [ "$#" = 0 ] || fail 'Unexpected arguments' ;;
  *) fail 'Usage: install.sh [--archive /path/to/package.tar.gz]' ;;
esac
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if [ -z "$archive" ] && [ -f "$script_dir/release-manifest.json" ]; then
  exec "$script_dir/runtime/node" "$script_dir/lib/install.js"
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/hhu-download.XXXXXXXX")
# Remove only this invocation's private download directory, never an installed release or user data.
cleanup() { rm -r -- "$work"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "$archive" ]; then
  [ "$(basename -- "$archive")" = "$ARCHIVE" ] || fail "Expected $ARCHIVE"
  checksums="$(dirname -- "$archive")/SHA256SUMS.txt"
  [ -f "$checksums" ] || fail "Missing checksum file: $checksums"
  cp -- "$archive" "$work/$ARCHIVE"
  cp -- "$checksums" "$work/SHA256SUMS.txt"
else
  command -v curl >/dev/null 2>&1 || fail 'Install curl to download a GitHub Release.'
  url="https://github.com/$REPOSITORY/releases/download/v$VERSION"
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 "$url/$ARCHIVE" -o "$work/$ARCHIVE"
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 "$url/SHA256SUMS.txt" -o "$work/SHA256SUMS.txt"
fi
expected=$(awk -v name="$ARCHIVE" '$2 == name { print $1 }' "$work/SHA256SUMS.txt")
[ "${#expected}" = 64 ] || fail 'Missing or ambiguous archive checksum.'
case "$expected" in *[!0-9a-fA-F]*) fail 'Invalid checksum.' ;; esac
(cd "$work" && echo "$expected  $ARCHIVE" | sha256sum --check --status) || fail 'Archive checksum mismatch; nothing installed.'
tar -tzf "$work/$ARCHIVE" > "$work/entries"
awk -v root="harnesshub-$VERSION-linux-x64" '
  $0 !~ ("^" root "(/|$)") || $0 ~ /(^|\/)\.\.(\/|$)/ || $0 ~ /^\// { bad=1 }
  END { exit bad }
' "$work/entries" || fail 'Unsafe archive paths.'
tar -xzf "$work/$ARCHIVE" --no-same-owner --same-permissions -C "$work"
payload="$work/harnesshub-$VERSION-linux-x64"
"$payload/runtime/node" "$payload/lib/install.js"
