---
name: requesting-code-review
description: 在完成任务、实现重大功能或合并之前使用，用于验证工作成果是否满足需求。触发词：代码审查、完成任务、合并前验证、code review、before merging、verify work。
---

# Requesting Code Review

Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history. This keeps the reviewer focused on the work product, not your thought process, and preserves your own context for continued work.

**Core principle:** Review at the appropriate workflow boundary. Do not repeat independent review of the same unchanged diff.

## When to Request Review

**Mandatory:**
- At the final whole-branch review stage in subagent-driven development; that stage is owned by the SDD workflow
- After completing a major feature when no existing review covers the current diff
- Before merge to main when no existing review covers the current BASE..HEAD range

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

A review satisfies every applicable trigger for the same unchanged BASE..HEAD range. Do not dispatch another reviewer merely because the feature is also complete or ready to merge. Code changes require verification and review of the new diff; a re-review after fixes belongs to the existing review stage.

## How to Request

**1. Get git SHAs:**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Dispatch code reviewer subagent:**

Dispatch a locally registered `reviewer` subagent, filling the template at [code-reviewer.md](code-reviewer.md).

- Use `reviewer` for code review in this environment; it is the dedicated read-only code-review agent.
- If `reviewer` is unavailable, check the actual available agent names and choose a registered agent capable of read-only review (for example, `worker` with explicit read-only instructions).
- Never invent an agent name. Do not dispatch `general-purpose` unless it is actually registered in the current environment.

**Placeholders:**
- `{DESCRIPTION}` - Brief summary of what you built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit
- `{TEST_EVIDENCE}` - Verification report paths or test evidence, including the tested HEAD SHA when available

**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[All tasks in the deployment plan are complete]
[Focused tests pass; the controller ran the full suite on HEAD and wrote a verification report]

You: Let me request the final whole-branch review.

BASE_SHA=$(git merge-base main HEAD)
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code reviewer subagent]
  DESCRIPTION: Completed the deployment plan, including verification and recovery modes
  PLAN_OR_REQUIREMENTS: docs/superpowers/plans/deployment-plan.md
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661
  TEST_EVIDENCE: .superpowers/sdd/final-verification-3df7661.md

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready with fixes

You: [Fix progress indicators and run covering tests]
[Regenerate the whole-branch package and re-review the new HEAD as part of the same final review stage]
```

## Integration with Workflows

**Subagent-Driven Development:**
- The SDD controller owns one final whole-branch review after all tasks
- Do not dispatch reviewers between tasks
- Do not run another feature-completion or pre-merge review after the SDD final review unless the code has changed

**Executing Plans:**
- Review at a natural milestone or after plan completion
- Use one final review for the completed plan; re-review only after code changes

**Ad-Hoc Development:**
- Review before merge when no existing review covers the current diff
- Review when stuck

## Red Flags

**Never:**
- Skip review because "it's simple"
- Repeat independent review of the same unchanged diff under a different trigger
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: [code-reviewer.md](code-reviewer.md)
