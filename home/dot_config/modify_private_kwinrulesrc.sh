#!/bin/sh
# chezmoi modify_ script: assert the five "login placement" window rules in
# ~/.config/kwinrulesrc and leave every other rule in the file to KWin.
#
# This has to be a modify_ script rather than a plain source file for the same reason
# modify_powerdevilrc.sh next door does: KWin OWNS this file and rewrites it. Every rule
# added through System Settings -> Window Management -> Window Rules lands here, written by
# KConfig, and so does the Bitwarden Stream Deck placement rule that predates this script. A
# plain managed file would delete all of it on every apply and KDE would write it back, so the
# two would fight forever with `chezmoi status` permanently dirty.
#
# WHAT IS OWNED: the five UUID-keyed sections below and nothing else. They pin Discord,
# Firefox, Ghostty, Spotify and Obsidian to a coordinate inside their assigned monitor, and
# maximize them there, at login. ~/.local/bin/login-window-layout starts those five apps and
# relies on these rules for placement -- it deliberately decides only *what* runs, never
# where, because KWin's own screen=N rule is inert on Wayland here (it matches the window and
# then never moves it). Losing these rules does not break the launcher loudly; it just opens
# five windows into default placement.
#
# Each owned section is asserted WHOLE, not key-by-key. We mean "this rule is exactly this",
# so a key KDE adds to one of these five is removed on the next apply. Sections we do not own
# pass through untouched, keys and order alike.
#
# [General] is rewritten rather than passed through, because it carries the rule INDEX:
# `rules=` is a comma-separated list of the UUIDs KWin will actually load, and `count=` is its
# length. A section not named in `rules=` is dead config -- so adding a rule section without
# also adding it to that list would produce a file that looks right and does nothing. Existing
# entries keep their position (order in `rules=` is rule precedence, so reordering it would
# silently change which rule wins where two match the same window); only genuinely absent
# UUIDs are appended, and any other key in [General] is left alone.
#
# Deliberately NOT done with kwriteconfig6, matching the reasoning in modify_powerdevilrc.sh:
# that would add a KDE binary to the apply path on hosts that may not have it, and it wants a
# real file rather than a stream. The awk below is dependency-free and its output is a pure
# function of its input, which is what chezmoi needs in order to see "no change" on a second
# apply. Blank lines are dropped on the way in and re-emitted as exactly one between sections,
# so the normalisation is a fixed point rather than something that grows on each run.
#
# The rules are gated to this host in .chezmoiignore -- every position below is an absolute
# coordinate inside one of this box's four outputs, which is wrong rather than merely useless
# on a machine laid out differently.
set -eu

CANON="$(mktemp "${TMPDIR:-/tmp}/chezmoi-kwinrulesrc-canon.XXXXXX")"
CURRENT="$(mktemp "${TMPDIR:-/tmp}/chezmoi-kwinrulesrc-cur.XXXXXX")"
trap 'rm -f "$CANON" "$CURRENT"' EXIT

# Drain stdin unconditionally: leaving it unread can SIGPIPE chezmoi. Empty means the target
# does not exist yet (first apply), which the awk END block handles by writing every owned
# section plus a [General] that indexes them.
cat >"$CURRENT"

# Owned sections, in the ASCII order KConfig sorts section headers into, so a file written
# from empty input already looks like one KDE has rewritten.
cat >"$CANON" <<'EOF'
[2e9c7a55-8d13-4f26-b0c4-5a7e91d2f308]
Description=Spotify - login placement (bottom)
maximizehoriz=true
maximizehorizrule=3
maximizevert=true
maximizevertrule=3
position=3283,904
positionrule=3
wmclass=spotify
wmclasscomplete=false
wmclassmatch=1
[7f3a1c20-4b5e-4d61-9a02-1c8e6f0b3d47]
Description=Firefox - login placement (main)
maximizehoriz=true
maximizehorizrule=3
maximizevert=true
maximizevertrule=3
position=1576,40
positionrule=3
wmclass=org.mozilla.firefox
wmclasscomplete=false
wmclassmatch=1
[923685de-9867-49f5-bed2-8a1da53e8b52]
Description=Obsidian - login placement (bottom)
maximizehoriz=true
maximizehorizrule=3
maximizevert=true
maximizevertrule=3
position=3283,904
positionrule=3
wmclass=md.Obsidian
wmclasscomplete=false
wmclassmatch=1
[d31e37ca-991b-4265-b5a5-770bbdb42c82]
Description=Ghostty - login placement (right)
maximizehoriz=true
maximizehorizrule=3
maximizevert=true
maximizevertrule=3
position=3283,40
positionrule=3
wmclass=com.mitchellh.ghostty
wmclasscomplete=false
wmclassmatch=1
[d68fa888-6425-4f4c-bd4a-a106d577356a]
Description=Discord - login placement (left)
maximizehoriz=true
maximizehorizrule=3
maximizevert=true
maximizevertrule=3
position=40,40
positionrule=3
wmclass=discord
wmclasscomplete=false
wmclassmatch=1
EOF

awk '
	# First file: the owned sections. Section headers are matched as whole lines rather
	# than parsed, so a UUID is never split on its own hyphens.
	NR == FNR {
		if ($0 ~ /^\[/) { sec = $0; order_own[++n_own] = sec; canon[sec] = ""; next }
		if (sec != "" && $0 != "") { canon[sec] = canon[sec] $0 "\n" }
		next
	}

	# Second file: the deployed target. Record section order, accumulate bodies, and drop
	# blank lines -- they are separators, re-emitted uniformly below.
	{
		if ($0 ~ /^\[/) {
			sec = $0
			if (!(sec in seen)) { seen[sec] = 1; order[++n_sec] = sec }
			next
		}
		if (n_sec == 0) { preamble = preamble $0 "\n"; next }
		if ($0 == "") { next }
		body[sec] = body[sec] $0 "\n"
	}

	END {
		gen = "[General]"

		# Owned sections the target does not have yet, then [General] if it is missing
		# too (an empty target, or one that somehow lost its index).
		for (i = 1; i <= n_own; i++) {
			s = order_own[i]
			if (!(s in seen)) { seen[s] = 1; order[++n_sec] = s }
		}
		if (!(gen in seen)) { seen[gen] = 1; order[++n_sec] = gen }

		# Rebuild the rule index. Entries already present keep their position; only
		# UUIDs absent from the list are appended.
		n_rules = 0
		if (gen in body) {
			n = split(body[gen], gl, "\n")
			for (i = 1; i <= n; i++) {
				if (index(gl[i], "rules=") != 1) { continue }
				m = split(substr(gl[i], length("rules=") + 1), part, ",")
				for (j = 1; j <= m; j++) {
					if (part[j] == "" || (part[j] in listed)) { continue }
					listed[part[j]] = 1
					rules[++n_rules] = part[j]
				}
			}
		}
		for (i = 1; i <= n_own; i++) {
			u = substr(order_own[i], 2, length(order_own[i]) - 2)
			if (u in listed) { continue }
			listed[u] = 1
			rules[++n_rules] = u
		}
		rules_line = ""
		for (i = 1; i <= n_rules; i++) {
			rules_line = rules_line (i > 1 ? "," : "") rules[i]
		}

		if (preamble != "") { printf "%s", preamble; started = 1 }
		for (i = 1; i <= n_sec; i++) {
			s = order[i]
			if (started) { print "" }
			started = 1
			print s

			if (s in canon) { printf "%s", canon[s]; continue }

			if (s != gen) { printf "%s", body[s]; continue }

			# [General]: count and rules are replaced where they already sit, so a
			# file that has them keeps KConfig key order; every other key here
			# belongs to somebody else and passes through.
			has_count = 0; has_rules = 0
			n = split(body[gen], gl, "\n")
			for (j = 1; j <= n; j++) {
				if (gl[j] == "") { continue }
				if (index(gl[j], "count=") == 1) {
					print "count=" n_rules; has_count = 1; continue
				}
				if (index(gl[j], "rules=") == 1) {
					print "rules=" rules_line; has_rules = 1; continue
				}
				print gl[j]
			}
			if (!has_count) { print "count=" n_rules }
			if (!has_rules) { print "rules=" rules_line }
		}
	}
' "$CANON" "$CURRENT"
