#!/usr/bin/env bash

cleanup_isolated_compose_project() {
	local project_name=$1
	local compose_file=$2
	local volume project_label

	docker compose -p "$project_name" -f "$compose_file" down -v --remove-orphans || return
	while IFS= read -r volume; do
		[[ -n $volume ]] || continue
		project_label=$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$volume") || return
		if [[ $project_label != "$project_name" ]]; then
			printf 'FAIL: refusing to remove Volume %s with project label %s\n' "$volume" "$project_label" >&2
			return 1
		fi
		docker volume rm "$volume" >/dev/null || return
	done < <(docker volume ls --quiet --filter "label=com.docker.compose.project=$project_name")
}
