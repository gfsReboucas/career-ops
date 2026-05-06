---
name: career-ops
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
license: MIT
---

# career-ops for Codex

This repository keeps the portable skill implementation at:

`../../../.agents/skills/career-ops/SKILL.md`

When this skill is invoked, read that file and follow its router instructions.

Common Codex invocations:

```text
Use the career-ops skill to scan for jobs.
Use the career-ops skill in pipeline mode.
Use the career-ops skill to evaluate this job URL: https://...
Use the career-ops skill to generate an ATS PDF.
```

For non-interactive runs:

```bash
codex exec --sandbox workspace-write "Use the career-ops skill to run scan mode"
codex exec --sandbox workspace-write "Use the career-ops skill to evaluate this job URL: https://..."
```
