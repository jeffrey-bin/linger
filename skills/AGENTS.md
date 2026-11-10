# Built-in Skill assets

This module owns versioned Skill packages shipped with Linger.
TeamHub embeds these assets and owns their persistence, lifecycle policy, and
runtime authorization.

## Structure

- `builtin/catalog.yaml`: declarative catalog of built-in Skill identities,
  immutable versions, bootstrap selectors, and initial Agent Type defaults.
- `builtin/<skill-name>/<version>/`: one immutable Skill package version with a
  root `SKILL.md` and optional `agents/`, `scripts/`, `references/`, or `assets/`.
- `embed.go`: the only Go API; it exposes the embedded filesystem to TeamHub.

## Important Conventions

- Never edit a published version in place. Add a new version directory and a
  new catalog manifest entry. `make check BASE=<target-ref>` enforces this with
  `apps/teamhub/scripts/check-builtin-skill-immutability.sh`, which fails when a
  file under a version directory present at the merge base is added, changed,
  or deleted. A version may be retired only by removing its complete version
  directory together with its `package_path` entry in `builtin/catalog.yaml`.
  When a whole Skill is retired, delete its database rows with a TeamHub
  migration in the same change. Partial edits to a retained version remain
  forbidden.
- Keep Skill names equal to their version-directory parent and to the
  `SKILL.md` frontmatter `name`.
- Keep product content here and TeamHub database or Object Store behavior in
  `apps/teamhub/internal/skill`.
- Run TeamHub unit and integration checks after changing catalog entries or
  package contents.
