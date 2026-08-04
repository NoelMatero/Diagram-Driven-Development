---
description: Put the drift notice back to its short form
allowed-tools: Bash(npm run check:drift -- --shrink), Bash(npx -y -p board-ai board-drift --shrink)
---

The notice has been left expanded by `/expand-report`, and should go back to
counts.

## Run it

```
npm run check:drift -- --shrink
```

Or `npx -y -p board-ai board-drift --shrink` when the script is not in this
project.

Print the output as-is in a code block, or say in one line that nothing is out of
date if it prints nothing. The notice stays short from here until somebody expands
it again.
