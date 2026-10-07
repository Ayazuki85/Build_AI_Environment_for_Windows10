# academic-research-skills (migrated copy)

Self-contained copies of the academic-paper, academic-paper-reviewer and
deep-research skills, plus their dependency layers.

- shared/            shared protocols, contracts and reference docs used by the
                     three skills above. Not a standalone skill.
- scripts/           Python tooling referenced by the three skills. Not a skill.

Note (2025-10-03): internal references were rewritten to directory-relative form (`../shared/`, `../scripts/`), dead upstream-only citations (`.claude/CLAUDE.md`, `docs/design/`, `docs/PERFORMANCE.md`, `ROADMAP_v3.2.md`) were removed, and `academic-pipeline/` was deleted at the user's request (backup: `~/.agents/academic-pipeline-backup.tar.gz`). The `description:` key was also removed from `shared/agents/compliance_agent.md` — pi auto-discovers frontmatter-bearing .md files under `~/.agents/skills`, so it was being registered as a standalone skill and triggering the pi naming-spec warning. Re-syncing from upstream would undo these fixes and must re-apply them.

Source repo: C:\Users\zk\.agents\academic-research-skills\ (git repo, kept as-is)

To re-sync after `git pull` in the source repo:
    powershell -ExecutionPolicy Bypass -File C:\Users\zk\.agents\sync-ars-skills.ps1

Runtime deps: Python 3 + pyyaml + jsonschema