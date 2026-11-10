#!/usr/bin/env node
// Creates this checkout's owner account once and keeps its password in
// .linger-runtime/local-owner.json. The file is written only after the
// account exists, so a failed run leaves no password behind that cannot sign in.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const localOwnerFile = ".linger-runtime/local-owner.json";

let owner;
let generated = false;
try {
  owner = JSON.parse(await readFile(path.join(root, localOwnerFile), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  generated = true;
  owner = {
    owner_email: process.env.OWNER_EMAIL?.trim() || "owner@linger.local",
    owner_password: randomBytes(10).toString("hex"),
  };
}

function account(command) {
  const result = spawnSync(
    "go",
    [
      "run",
      "./cmd/account",
      command,
      "--email",
      owner.owner_email,
      "--password-stdin",
    ],
    {
      cwd: path.join(root, "apps/teamhub"),
      input: owner.owner_password,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

account("create-owner");
if (generated) {
  // Without the file the database password is unknown, so reset it to the new
  // one. Deleting the file therefore resets the password and every Session.
  account("set-password");
  await mkdir(path.join(root, path.dirname(localOwnerFile)), {
    recursive: true,
  });
  await writeFile(
    path.join(root, localOwnerFile),
    `${JSON.stringify(owner, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Owner password: ${owner.owner_password} (shown once)`);
}
console.log(
  `Owner account: ${owner.owner_email} (password saved in ${localOwnerFile})`,
);
