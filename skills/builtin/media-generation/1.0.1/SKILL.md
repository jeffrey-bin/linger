---
name: media-generation
description: Generate images and videos with the user's connected fal or Higgsfield account through teamhub image-gen and teamhub video-gen. Choose a model, start the job, check it later without blocking, and deliver the saved file. Use when the user asks you to create, draw, render or animate an image or video. Not for plain crops, resizes or format conversions of an existing file, and not for audio or 3D.
---

# Image and video generation

`teamhub image-gen` and `teamhub video-gen` run generation on the user's own connected fal or Higgsfield account and spend its balance. When one of them is connected, generate through these commands. Do not substitute a Runtime's built-in image tool, and never fake a video by panning or zooming a still image locally. Plain crops, resizes and conversions of an existing file stay local work.

Both commands take the same flags; `--help` is offline and grants no permission. Add `--json` and read the fields named below.

## 1. Account

Run `teamhub apps list --json`. Connected App keys are `fal_ai` for fal and `higgsfield` for Higgsfield. If the provider the user wants has no delegated account, run `teamhub apps connect fal_ai` or `teamhub apps connect higgsfield`. It posts an authorization card in this chat; continue once the user completes it. When this deployment has no Composio API key yet, the first card asks for that key instead; once the user saves it, run `teamhub apps connect` again for the provider's own card. If the user named no provider, use the connected one; when both are connected, use the one whose models fit the request.

## 2. Model and parameters

```bash
teamhub image-gen --provider fal --price --json
teamhub video-gen --provider higgsfield --price --model kling3_0 --json
```

- Without `--model`, `--price` lists models of that output type; continue with `--cursor <nextCursor>` while `hasMore` is true. fal rows carry `price` (unit price, unit, currency). Higgsfield returns `pricingStatus: unavailable`: its credit cost is not queryable here, so do not invent one.
- With `--model`, it also returns the model's parameters: fal `inputs` are input fields such as `image_url`, Higgsfield `medias` are reference roles such as `start_image`, plus durations and aspect ratios. Read them before setting anything.
- Use the model the user names. Otherwise pick one that fits and tell the user which. Before a video or a batch of several images, tell the user the model and, for fal, its unit price.

## 3. Start the job

```bash
teamhub image-gen --provider fal --model fal-ai/flux/dev --prompt "a red fox in snow" --set image_size=landscape_16_9 --output ./playground/<scope-id>/fox.png --json
teamhub video-gen --provider higgsfield --model kling3_0 --prompt "camera slowly orbits the bottle" --file start_image=./playground/<scope-id>/bottle.png --set duration=5 --output ./playground/<scope-id>/orbit.mp4 --json
```

- `--set field=value` passes one model parameter; JSON values keep their types. `--file field=local-path` uploads a local reference under a fal input field or Higgsfield media role; repeat it for array fields. Pass an existing HTTPS reference with `--set` instead.
- `--output` names a new file (or a new directory for several results). Nothing is written yet; the path is reused when the job is checked.
- The command returns as soon as the provider accepts the job: fal gives `requestId`, Higgsfield gives `jobs[].jobId`, and both give `nextCommand`. Keep `nextCommand` exactly as returned; it selects the same account, model and output.
- Higgsfield may return `unlimitedChoice` with `jobs: []`: nothing started. Ask the user whether to spend unlimited generations or credits, then rerun with `--set use_unlim=true` or `--set use_unlim=false`. `rejected` means Higgsfield refused the job (for example, not enough credits); tell the user its reason.

## 4. Check without blocking

Tell the user in one short message that the image or video is being generated. Then run `nextCommand` to check the job once:

- An image usually takes 10-60 seconds: check about 20 seconds after starting. A video usually takes several minutes: check about a minute after starting, then every minute or two.
- Between checks, finish other pending work; use a short `sleep` only when nothing else is left. Run each check yourself; do not wrap the CLI in a polling script.
- Both providers report `status` as `queued`, `running`, `completed` or `failed`. A job that is `queued` or `running` returns `nextCommand` again; use the newest one.
- When every job has ended, the check saves the results to `--output` and returns `files` with paths; missing folders in that path are created. A `failed` job has no file and its `error` says why, such as a safety or copyright block: tell the user and ask before paying for another attempt.
- If a video is still running after about 15 minutes (an image after about 5), tell the user it is still in progress and keep the job ID, so you can check again when they ask.

## 5. Deliver

Attach the saved file to a message:

```bash
teamhub message send --content "Here is the fox illustration." --attach ./playground/<scope-id>/fox.png --json
```

In a Task you do not send messages: leave the file under `./playground/<task-id>/` and name it in your final reply. If a saved file has a `warning` about its extension, rename it to the extension the warning names before attaching it.

## Failures

- `outcome_unknown` after a submission means a paid job may have started. Never rerun the generation. Read `issues` for the provider's reason and continue with the `nextCommand` in `partial_receipts`.
- A `--job` check never submits or charges, so a failed check can be run again once its cause is fixed, for example with a new `--output` path.
- `file_transfer_failed` keeps the files already saved. Run the job check again with a new `--output` path; it does not submit or charge again.
- A provider error about too many concurrent jobs (Higgsfield's starter plan allows two) means start the next job after an earlier one ends.
- A denied permission review means the user declined this spend. Do not retry through the other provider or a built-in tool to get around it.
