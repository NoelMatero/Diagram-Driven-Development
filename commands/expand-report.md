---
description: Show every stale box and arrow, per diagram, instead of the summary
allowed-tools: Bash(npm run check:drift -- --details), Bash(npx -y -p board-ai board-drift --details), mcp__board__check_drift, Read, Grep, Glob
---

The drift notice is trimmed on purpose: it fires at the end of every turn, so it
shows counts and the first few findings. This shows all of them.

## Run it

```
npm run check:drift -- --details
```

If that script is not in this project — the usual case, since the notice comes from
an installed plugin — run `npx -y -p board-ai board-drift --details` instead.

Print the output as-is, in a code block, and stop. One box per diagram, every
finding listed, the command to fix it in the bottom border. It is already the
answer; summarising it again in prose is the one thing not to do.

If nothing is out of date, say so in a line.

## If asked what a finding means

**Red** — a box points at a file, or a name inside a file, that is not in the repo
any more. Two causes needing opposite fixes: the code *moved*, so the box should
point at its new home; or the code is *gone*, so the box should be removed along
with any arrows that only existed to reach it. Work out which before advising
either.

**Yellow** — the diagram draws A → B and nothing in the code connects those two
files: no import in either direction, no third file importing both, no shared
route string. That is not "the arrow is wrong". Arrows legitimately describe data
flowing through an orchestrator, one service calling another over HTTP, events,
injection — none of which leave a static trace. Say "worth a look", never "wrong".

A box whose reference was **guessed from a hand-drawn label** is flagged as
inferred. Ask before changing someone's sketch; the reference was our inference,
not their claim.

`docs/drift-check.md` has the reasoning, including why the check is deliberately
generous — roughly three in four invented arrows pass unnoticed, which is the price
of never crying wolf.
