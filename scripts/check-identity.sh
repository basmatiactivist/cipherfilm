#!/bin/sh
# Stops a commit or tag from carrying a real e-mail address to GitHub, where it can't be removed again
# (closed pull requests keep old commits for good). Allowed: <id>+<login>@users.noreply.github.com and
# GitHub's own noreply@github.com. Never prints an address, so CI logs stay clean too.
#   check-identity.sh                        the author and committer the next commit gets (pre-commit hook)
#   check-identity.sh [--committer] REVS...  the commits git log REVS lists, and every tag among REVS
set -eu
ok() { case "$1" in *@users.noreply.github.com | noreply@github.com) ;; *) return 1 ;; esac; }
fix="git config user.email <id>+<login>@users.noreply.github.com (the address is on github.com/settings/emails)"
bad=0

if [ $# -eq 0 ]; then
  for who in AUTHOR COMMITTER; do
    ok "$(git var GIT_${who}_IDENT | sed 's/.*<\(.*\)>.*/\1/')" ||
      { echo "check-identity: the next commit's $who address is not a noreply address. Run: $fix" >&2; bad=1; }
  done
  exit $bad
fi

fmt='%H %ae %ce'
if [ "$1" = --committer ]; then fmt='%H %ce %ce'; shift; fi # contributors' own commits keep their address
for rev in "$@"; do
  case "$rev" in -* | ^* | *..*) continue ;; esac
  if [ "$(git cat-file -t "$rev")" = tag ]; then
    ok "$(git cat-file -p "$rev" | sed -n 's/^tagger .*<\(.*\)>.*/\1/p')" ||
      { echo "check-identity: tag $rev carries a real e-mail address. Run: $fix, then recreate the tag" >&2; bad=1; }
  fi
done
# fail closed: if git log can't list the commits (an object that isn't here), nothing was checked
out=$(git log --format="$fmt" "$@") || { echo "check-identity: could not list the commits to check; fetch and try again" >&2; exit 1; }
[ -n "$out" ] || exit $bad
printf '%s\n' "$out" | awk -v fix="$fix" '
  { for (i = 2; i <= 3; i++) if ($i !~ /@users\.noreply\.github\.com$/ && $i != "noreply@github.com") {
      print "check-identity: commit " $1 " carries a real e-mail address"; bad = 1; next } }
  END { if (bad) print "check-identity: " fix ", then rewrite those commits"; exit bad }' >&2 || bad=1
exit $bad
