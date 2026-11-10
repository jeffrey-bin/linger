import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Without TEAMHUB_STATE_ROOT, a directly configured CLI keeps its private cache
// in the default configuration directory under HOME (os.homedir() when the
// command environment has no HOME). Give each test file a private home so no
// test reads or writes the developer's real configuration directory.
const home = mkdtempSync(path.join(tmpdir(), "teamhub-cli-home-"));
process.env.HOME = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.TEAMHUB_STATE_ROOT;
afterAll(() => rmSync(home, { recursive: true, force: true }));
