#!/usr/bin/env bash
set -euo pipefail
TEMPLATE="$1"
OUT="$2"
# Pass the program via -c so stdin stays free for the piped JSON; paths go
# through argv (single-quoted program = no shell interpolation, no temp file).
python3 -c '
import sys, json
template_path, out_path = sys.argv[1], sys.argv[2]
data = sys.stdin.read()
json.loads(data)  # fail loudly if not valid JSON
with open(template_path) as f:
    html = f.read()
marker = "/*__PR_FEEDBACK_DATA__*/null"
if html.count(marker) != 1:
    sys.exit("render: expected exactly one data marker in template")
with open(out_path, "w") as f:
    f.write(html.replace(marker, data))
print(out_path)
' "$TEMPLATE" "$OUT"
