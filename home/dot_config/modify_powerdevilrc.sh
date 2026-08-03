#!/bin/sh
# chezmoi modify_ script: enforce ONE key in ~/.config/powerdevilrc and leave the rest of
# the file to KDE.
#
# This has to be a modify_ script rather than a plain source file because PowerDevil OWNS
# this file and rewrites it. Anything set through System Settings -- power button action,
# dim timeout, the battery profiles on a laptop -- lands here, written by KConfig. A plain
# managed file would delete all of it on every apply, and KDE would write it back, so the
# two would fight forever with `chezmoi status` permanently dirty.
#
# So only TurnOffDisplayIdleTimeoutSec is asserted. Every other line on stdin is passed
# through untouched.
#
# WHY 600: the default was 1800, which left four panels (or, past the KVM, one 2560x1600)
# lit for half an hour after walking away. Display blanking is also the ONLY power lever
# that belongs here -- suspend is deliberately not configured by this script. The box has
# to stay awake for background Claude sessions, and its auto-suspend is already off via
# AutoSuspendAction=0, which lives in this same file and is passed through by the rule
# above rather than being re-asserted.
#
# Deliberately NOT done with kwriteconfig6: that would add a KDE binary to the apply path
# on hosts that may not have it, and it wants a real file rather than a stream. The awk
# below is dependency-free and its output is a pure function of its input, which is what
# chezmoi needs in order to see "no change" on a second apply.
set -eu

GROUP='[AC][Display]'
KEY='TurnOffDisplayIdleTimeoutSec'
VALUE='600'

# Drain stdin unconditionally: leaving it unread can SIGPIPE chezmoi. Empty means the target
# does not exist yet (first apply), which the awk END block handles by writing the group out.
CURRENT="$(mktemp "${TMPDIR:-/tmp}/chezmoi-powerdevilrc.XXXXXX")"
trap 'rm -f "$CURRENT"' EXIT
cat >"$CURRENT"

# Group headers are matched as whole lines, not by parsing "[AC]" and "[Display]" separately:
# KConfig writes a nested group as the single literal line `[AC][Display]`, so a naive INI
# parser that splits on brackets sees a group named `AC][Display` and gets the nesting wrong.
awk -v group="$GROUP" -v key="$KEY" -v value="$VALUE" '
	BEGIN { in_group = 0; seen_group = 0; done = 0 }

	/^\[/ {
		# Leaving the target group without having seen the key: append it here, while we
		# still know we are inside the right group.
		if (in_group && !done) { print key "=" value; done = 1 }
		in_group = ($0 == group)
		if (in_group) { seen_group = 1 }
		print
		next
	}

	{
		# Replace the first occurrence in the target group and drop any duplicates, so a
		# file KDE has written twice converges instead of growing.
		if (in_group && index($0, key "=") == 1) {
			if (!done) { print key "=" value; done = 1 }
			next
		}
		print
	}

	END {
		if (in_group && !done) { print key "=" value; done = 1 }
		if (!seen_group) {
			# Blank line only when separating from existing content -- an empty target
			# must not gain a leading blank, or the output stops being idempotent.
			if (NR > 0) { print "" }
			print group
			print key "=" value
		}
	}
' "$CURRENT"
