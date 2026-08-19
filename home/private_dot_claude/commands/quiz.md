---
description: "Quiz: spaced-repetition review of the vault's Learning cards — one question at a time, then advance each card's interval."
---

Invoke the `learning-quiz` skill and follow it exactly.

It is `/quiz` because that is the name Daniel types. The skill keeps the
`learning-quiz` name because `run-skill.sh` keys its log file and its per-day
done-marker on the skill name, and the launchd job
(`com.daniel.claude.learning-quiz`) names it too.

This is the interactive half — ask one question at a time and grade. The morning
sheet is a separate deterministic script (`scripts/render-sheet.sh`, run by
launchd); never render it from here.
