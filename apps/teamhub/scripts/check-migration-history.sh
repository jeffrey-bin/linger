#!/usr/bin/env bash
set -euo pipefail

# The caller refreshes/resolves the target. No network or database access here.
if [[ -z ${1:-} ]]; then
	echo "Usage: $0 <target-ref> [candidate-ref]" >&2
	exit 2
fi
target_ref=$1
candidate_ref=${2:-}
repository_root=$(git rev-parse --show-toplevel)

python3 - "$repository_root" "$target_ref" "$candidate_ref" <<'PY'
import json
import re
import subprocess
import sys
from pathlib import Path

repository_root, target_ref, candidate_ref = sys.argv[1:]
migration_directory = "apps/teamhub/migrations"


def git(*arguments):
    result = subprocess.run(
        ["git", "-C", repository_root, *arguments],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit(f"cannot read migration ref: {arguments[-1]}; fetch the target branch first")
    return result.stdout


def tree_migrations(reference):
    tree = git("rev-parse", "--verify", "--end-of-options", f"{reference}^{{tree}}").decode().strip()
    entries = git("ls-tree", "-r", "-z", "--full-tree", tree, "--", migration_directory)
    result = {}
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, filename = entry.split(b"\t", 1)
        filename = filename.decode()
        if Path(filename).parent.as_posix() == migration_directory and filename.endswith(".sql"):
            mode, kind, digest = metadata.decode().split()
            if kind != "blob" or mode not in ("100644", "100755"):
                raise SystemExit(f"migration must be a regular SQL file: {filename}")
            result[filename] = digest
    return result


def working_migrations():
    result = {}
    for filename in sorted((Path(repository_root) / migration_directory).glob("*.sql")):
        if filename.is_symlink() or not filename.is_file():
            raise SystemExit(f"migration must be a regular SQL file: {filename.name}")
        # Hash the exact worktree bytes, including uncommitted/new SQL. Git's
        # content filters must not disguise a changed migration body.
        relative = filename.relative_to(repository_root).as_posix()
        result[relative] = git("hash-object", "--no-filters", "--", str(filename)).decode().strip()
    return result


def versions(files):
    result = {}
    for filename in files:
        match = re.fullmatch(r"([0-9]+)_.+\.sql", Path(filename).name)
        if not match:
            raise SystemExit(f"invalid migration filename: {filename}")
        version = int(match.group(1))
        if version in result:
            raise SystemExit(f"duplicate migration version {version}: {result[version]} and {filename}")
        result[version] = filename
    return result


target_files = tree_migrations(target_ref)
if not target_files:
    raise SystemExit(f"no target migrations found: {target_ref}")
candidate_files = tree_migrations(candidate_ref) if candidate_ref else working_migrations()
target_versions = versions(target_files)
versions(candidate_files)
# Missing files compare the fork point, not the moving target tip.
# A pull request's merge result already contains every SQL that landed on the
# target after the fork, so requiring those files on the source branch was a
# rebase tax: any pull request that had not rebased failed as soon as the
# target gained a migration.
# SQL that existed at merge-base is already published; deleting or rewriting
# it would still land on merge, so those stay fail-closed against merge-base.
# Modified also compares same-name files on the candidate and the target tip.
# After a fork both sides can add 00501_dev.sql with different bytes; that
# file is not in merge-base, so a merge-base-only
# modified check would miss it. Git merge would add/add conflict, but this
# gate must still fail closed. New version numbers still have to beat the
# target tip maximum so they cannot collide with SQL that landed on the
# target after the fork. No common ancestor (unrelated histories or a clone
# too shallow to connect the refs) fails closed; skipping would drop the
# gate. This checker does not fetch.
candidate_commit = candidate_ref or "HEAD"
merge_base_result = subprocess.run(
    ["git", "-C", repository_root, "merge-base", target_ref, candidate_commit],
    capture_output=True,
    check=False,
)
if merge_base_result.returncode or not merge_base_result.stdout.strip():
    raise SystemExit(
        f"cannot resolve merge-base of {target_ref} and {candidate_commit}; "
        "fetch complete history that includes a common ancestor"
    )
published_ref = merge_base_result.stdout.decode().strip()
published_files = tree_migrations(published_ref)
# The schema baseline replaces every migration up to its own version, which
# it takes over from the last file it replaced, so a database already at that
# version skips it. Those published files may be deleted only together with
# the baseline; rewriting one, or deleting any later published SQL, still
# fails closed.
baseline_file = f"{migration_directory}/00852_baseline.sql"
retired_maximum = 852
for filename, digest in published_files.items():
    if filename not in candidate_files:
        if baseline_file in candidate_files and next(iter(versions([filename]))) <= retired_maximum:
            continue
        raise SystemExit(f"missing published migration: {filename}; restore the file as it exists at merge-base {published_ref}")
    if candidate_files[filename] != digest:
        raise SystemExit(f"modified target migration: {filename}; restore it and use a new forward migration")
for filename, digest in target_files.items():
    if filename in candidate_files and candidate_files[filename] != digest:
        raise SystemExit(f"modified target migration: {filename}; restore it and use a new forward migration")

target_maximum = max(target_versions)
# SQL unchanged since merge-base is not new: a branch that forked before the
# baseline still carries the files it replaced, and the merge deletes them.
# The baseline itself reuses the version of the last file it replaces.
new_files = {
    filename: digest
    for filename, digest in candidate_files.items()
    if filename not in target_files and published_files.get(filename) != digest and filename != baseline_file
}
for version, filename in versions(new_files).items():
    if version <= target_maximum:
        raise SystemExit(f"new migration version must exceed target maximum {target_maximum}: {filename}; renumber unpublished SQL and update its references")

print(f"migration history verified: target={target_ref} merge-base={published_ref} latest={target_maximum} new={len(new_files)}")
PY
