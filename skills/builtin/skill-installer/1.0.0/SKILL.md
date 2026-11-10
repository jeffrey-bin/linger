---
name: skill-installer
description: Fetch a Skill folder from a GitHub repository and publish it to TeamHub so this Agent gains it as a bound Skill. Use when the user wants to add or install a Skill, shares a GitHub link to a Skill, or asks which Skills a repository offers.
---

# Skill Installer

A Skill counts as installed only after TeamHub has published it. Files you put
somewhere in the Runtime are temporary: Skill directories are rebuilt from the
authorized Snapshot whenever a Context activates, and nobody else can see what
you wrote there.

Work in two steps:

1. Download the Skill folder into the shared Playground.
2. Publish that folder with `teamhub profile skill publish`.

## Requirements

The scripts need `bash`, `curl`, `tar`, and `python3` (used only to read GitHub
JSON responses). Set `GITHUB_TOKEN` or `GH_TOKEN` to reach private repositories
or to avoid anonymous rate limits; the token is sent as a Bearer header.

## Find Skills in a repository

```bash
bash <this-skill-path>/scripts/list-skills.sh --repo owner/repo [--path skills] [--ref branch]
```

It prints every child directory of `--path` (default `skills`) that has a
`SKILL.md`, one per line. Show the user that list and ask which ones they want
before installing anything.

## 1. Download into the Playground

Pick the Playground folder for the current work so other Contexts are not
disturbed: `./playground/<room_id>/`, `./playground/<task_id>/`, or
`./playground/<document_id>/`.

From a GitHub folder link:

```bash
bash <this-skill-path>/scripts/fetch-skill.sh \
  --url https://github.com/owner/repo/tree/main/path/to/skill \
  --dest ./playground/<scope-id>
```

From repository coordinates (`--ref` defaults to the default branch):

```bash
bash <this-skill-path>/scripts/fetch-skill.sh \
  --repo owner/repo --path path/to/skill [--ref branch] \
  --dest ./playground/<scope-id> [--name skill-name]
```

The folder lands at `<dest>/<name>`, where `<name>` defaults to the last
segment of the path. The script stops if that folder already exists, if the
downloaded folder has no `SKILL.md` at its root, or if it contains symbolic or
hard links. A `--url` ref must be a single path segment; for branch names that
contain `/`, use `--repo`/`--path`/`--ref`.

## 2. Publish to TeamHub

```bash
teamhub profile skill publish ./playground/<scope-id>/<skill-name>
```

Publishing creates an immutable version and binds it to this Agent. When this
Agent already has a bound Skill whose `SKILL.md` name is the same, the upload
becomes a new version of that Skill; otherwise TeamHub creates a new Skill owned
by the Sponsor. The command reports `skill_id`, `manifest_version`, and
`binding_version`.

## When the new Skill becomes usable

The current Run keeps the Skill set it started with, so do not try to call the
new Skill now. Starting with the user's next message, this conversation has it;
other conversations of this Agent pick it up on their next Run. No extra action
is needed from the user. Tell them that the Skill is published and bound, that it
is not available in this Run, and that they can use it from their next message.

## Failures

If download, packing, authorization, or publishing fails, report the error as
it was printed and leave the downloaded folder in place so it can be fixed and
published again. Never describe copying files into the Runtime as an install.

When asked for several Skills, fetch and publish them one at a time and report
the result of each one separately, because each can fail independently.
