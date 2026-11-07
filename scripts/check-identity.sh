#!/bin/sh
# Stops a commit or tag from carrying a real e-mail address to GitHub, where it can't be removed again
# (closed pull requests keep old commits for good). Allowed: <id>+<login>@users.noreply.github.com (bots: <login>[bot]) and
# GitHub's own noreply@github.com; in messages (Co-authored-by: and the like) also noreply@anthropic.com.
# Never prints an address, so CI logs stay clean too.
#   check-identity.sh                        the author and committer the next commit gets (pre-commit hook)
#   check-identity.sh [--committer] REVS...  the commits git log REVS lists, and every tag among REVS: author,
#                                            committer, merged tags and every <address> in the messages
# --committer checks only the committer of a commit whose author is not a noreply address: a contributor's own
# commits keep their address, in the author line and in what they wrote.
set -eu
fix="git config user.email <id>+<login>@users.noreply.github.com (the address is on github.com/settings/emails)"
# the whole address must match, not just its end; awk reads it from the environment, so nothing in it is unescaped
okre='^([0-9]+[+][A-Za-z0-9-]+([[]bot[]])?@users[.]noreply[.]github[.]com|noreply@github[.]com)$'
msgre='^([0-9]+[+][A-Za-z0-9-]+([[]bot[]])?@users[.]noreply[.]github[.]com|noreply@github[.]com|noreply@anthropic[.]com)$'
ok() { A=$1 awk -v re="$okre" 'BEGIN { exit !(ENVIRON["A"] ~ re) }'; }
bad=0

if [ $# -eq 0 ]; then
  for who in AUTHOR COMMITTER; do
    ok "$(git var GIT_${who}_IDENT | sed 's/.*<\(.*\)>.*/\1/')" ||
      { echo "check-identity: the next commit's $who address is not a noreply address. Run: $fix" >&2; bad=1; }
  done
  exit $bad
fi

committer=0
if [ "$1" = --committer ]; then committer=1; shift; fi
# awk program shared by commits and tags (git's raw format, every message line indented): ident lines, also the
# indented tagger of a merged tag, must carry an allowed address, and so must every <...@...> on any other line.
# A line "commit X" starts the next commit; a tag is passed in as kind=tag and obj=NAME.
scan='
  function addr(s) { if (index(s, "<") == 0 || index(s, ">") == 0) return ""; sub(/^[^<]*</, "", s); sub(/>[^>]*$/, "", s); return s }
  function flag(what) { print "check-identity: " kind " " obj " carries a real e-mail address (" what ")"; bad = 1 }
  function check() {
    if (obj == "") return
    trusted = !committer || author ~ okre # with --committer, what a contributor wrote is theirs
    if (kind == "commit" && trusted && author !~ okre) flag("author")
    if (kind == "commit" && committer_ !~ okre) flag("committer")
    if (kind == "tag" && tagger !~ okre) flag("tagger")
    if (trusted && other != "") flag(other)
  }
  /^commit [0-9a-f]+$/ { check(); kind = "commit"; obj = $2; author = committer_ = tagger = other = ""; next }
  /^author /    { author = addr($0); next }
  /^committer / { committer_ = addr($0); next }
  /^tagger /    { tagger = addr($0); next }
  /^ tagger /   { if (addr($0) !~ okre) other = "merged tag"; next }
  { m = $0; while (match(m, /<[^<>]*@[^<>]*>/)) {
      if (substr(m, RSTART + 1, RLENGTH - 2) !~ msgre) other = "message"
      m = substr(m, RSTART + RLENGTH) } }
  END { check(); if (bad) print "check-identity: " fix ", then rewrite those commits or recreate those tags"; exit bad }'

for rev in "$@"; do
  case "$rev" in -* | ^* | *..*) continue ;; esac
  # a tag can point at another tag: every tagger on the way counts
  obj=$rev
  while [ "$(git cat-file -t "$obj" 2>/dev/null)" = tag ]; do
    raw=$(git --no-replace-objects cat-file tag "$obj") || { echo "check-identity: could not read tag $rev" >&2; exit 1; }
    # indent the message as git log does, so a line in it is never read as the tagger
    printf '%s\n' "$raw" | awk '!body && /^$/ { body = 1; next } { print (body ? "    " : "") $0 }' |
      awk -v kind=tag -v obj="$rev" -v okre="$okre" -v msgre="$msgre" -v committer=0 -v fix="$fix" "$scan" >&2 || bad=1
    obj=$(printf '%s\n' "$raw" | sed -n '1s/^object //p')
  done
done
# fail closed: if git log can't list the commits (an object that isn't here), nothing was checked
out=$(git --no-replace-objects log --pretty=raw --no-decorate --no-use-mailmap --no-show-signature "$@") ||
  { echo "check-identity: could not list the commits to check; fetch and try again" >&2; exit 1; }
[ -n "$out" ] || exit $bad
printf '%s\n' "$out" | awk -v okre="$okre" -v msgre="$msgre" -v committer=$committer -v fix="$fix" "$scan" >&2 || bad=1
exit $bad
