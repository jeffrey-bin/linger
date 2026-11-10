#!/usr/bin/env bash

set -euo pipefail

# Published built-in Skill versions are immutable. Every version directory present in
# the base tree must exist in HEAD as a tree with the identical object hash, unless the
# version is retired: the whole directory is gone from HEAD and its package_path no
# longer appears in HEAD's skills/builtin/catalog.yaml. Editing or deleting a file
# inside a retained version, adding a file to it, or replacing its content still
# fails. Other version directories new to HEAD are allowed.
#
# The base is the merge base with the target branch, not the target tip. A source branch
# that is behind its target does not look like it deleted versions the target gained
# after the branch point. The base is the merge base of BUILTIN_SKILL_BASE_REF (any
# commit-ish; make check passes BASE) and HEAD. Without it the check fails: the
# repository assumes no default branch.
repository_root=$(git rev-parse --show-toplevel)
builtin_root="skills/builtin"

base_source=${BUILTIN_SKILL_BASE_REF:-}
if [[ -z $base_source ]]; then
	printf '%s\n' 'built-in Skill immutability check needs a base: make check-builtin-skill-immutability BASE=<target-ref>' >&2
	exit 2
fi
if ! base_tip=$(git -C "$repository_root" rev-parse --verify --end-of-options "$base_source^{commit}" 2>/dev/null); then
	printf 'built-in Skill immutability check cannot resolve base ref: %s\n' "$base_source" >&2
	exit 1
fi
if ! base_commit=$(git -C "$repository_root" merge-base "$base_tip" HEAD); then
	printf 'built-in Skill immutability check cannot find a merge base with %s\n' "$base_source" >&2
	exit 1
fi

# List child tree names NUL-delimited so names with spaces stay intact. Each name is
# relative to the tree-ish it was listed from.
list_trees() {
	git -C "$repository_root" ls-tree -d -z --name-only "$1"
}

# package_path values HEAD's catalog still lists, one per line.
if ! catalog=$(git -C "$repository_root" show "HEAD:$builtin_root/catalog.yaml" 2>/dev/null); then
	printf 'built-in Skill immutability check cannot read %s/catalog.yaml at HEAD\n' "$builtin_root" >&2
	exit 1
fi
catalog_package_paths=$(awk '{ for (i = 1; i < NF; i++) if ($i == "package_path:") print $(i + 1) }' <<<"$catalog")
cataloged_in_head() {
	grep -Fqx -- "$1" <<<"$catalog_package_paths"
}

violation_dirs=()
violation_reasons=()
while IFS= read -r -d '' skill_name; do
	while IFS= read -r -d '' version_name; do
		version_dir="$builtin_root/$skill_name/$version_name"
		base_tree=$(git -C "$repository_root" rev-parse "$base_commit:$version_dir")
		if ! head_tree=$(git -C "$repository_root" rev-parse --verify --quiet "HEAD:$version_dir"); then
			if ! cataloged_in_head "builtin/$skill_name/$version_name"; then
				continue
			fi
			violation_dirs+=("$version_dir")
			violation_reasons+=("deleted while still in catalog")
		elif [[ $head_tree != "$base_tree" ]]; then
			violation_dirs+=("$version_dir")
			violation_reasons+=(modified)
		fi
	done < <(list_trees "$base_commit:$builtin_root/$skill_name")
done < <(list_trees "$base_commit:$builtin_root")

if ((${#violation_dirs[@]})); then
	printf '%s\n' 'built-in Skill immutability check failed:' >&2
	printf '%s\n' 'published built-in Skill versions are immutable; add a new version directory and catalog entry' >&2
	for index in "${!violation_dirs[@]}"; do
		version_dir=${violation_dirs[$index]}
		printf '  %s (%s)\n' "$version_dir" "${violation_reasons[$index]}" >&2
		# Changed files help the author see what to move into a new version directory.
		git -C "$repository_root" diff -z --name-only --no-renames "$base_commit" HEAD -- "$version_dir" |
			while IFS= read -r -d '' changed_path; do
				printf '    %s\n' "$changed_path" >&2
			done
	done
	exit 1
fi
printf '%s\n' "built-in Skill immutability check passed against $base_source"
