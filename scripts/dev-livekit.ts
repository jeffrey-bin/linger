import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `pnpm dev` runs the LiveKit server voice needs, as docker-compose.yml does,
// with the same ports and keys from .env. It runs only while a voice key is
// set and LIVEKIT_URL names this computer; otherwise the services use the
// LiveKit that LIVEKIT_URL names, or voice stays off.

// The media ports of the livekit service in docker-compose.yml.
const RTC_UDP_PORT = 7882;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type LiveKitDevPlan =
  | { action: "skip"; reason: string }
  | {
      action: "run";
      httpPort: number;
      keys: string;
      config: string;
      ffmpegNeeded: boolean;
    };

export function planDevLiveKit(environment: NodeJS.ProcessEnv): LiveKitDevPlan {
  const soniox = Boolean(environment.SONIOX_API_KEY?.trim());
  const xai = Boolean(environment.XAI_API_KEY?.trim());
  if (!soniox && !xai)
    return {
      action: "skip",
      reason:
        "Voice is off: set SONIOX_API_KEY or XAI_API_KEY in .env to run LiveKit with pnpm dev.",
    };
  const url = environment.LIVEKIT_URL?.trim();
  const key = environment.LIVEKIT_API_KEY?.trim();
  const secret = environment.LIVEKIT_API_SECRET?.trim();
  if (!url || !key || !secret)
    throw new Error(
      "Voice needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET; copy them from .env.example into .env.",
    );
  const parsed = new URL(url);
  if (!LOOPBACK_HOSTS.has(parsed.hostname))
    return {
      action: "skip",
      reason: `Using the LiveKit server at ${parsed.origin} that LIVEKIT_URL names.`,
    };
  const httpPort = Number(
    parsed.port || (parsed.protocol === "wss:" ? 443 : 80),
  );
  return {
    action: "run",
    httpPort,
    keys: `${key}: ${secret}`,
    // Loopback only, as Native runs it: LiveKit's ICE/TCP fallback listens on
    // every interface, so it stays off and media uses UDP on this computer.
    config: JSON.stringify({
      port: httpPort,
      bind_addresses: ["127.0.0.1"],
      rtc: {
        tcp_port: 0,
        udp_port: RTC_UDP_PORT,
        use_external_ip: false,
        node_ip: "127.0.0.1",
        enable_loopback_candidate: true,
        ips: { includes: ["127.0.0.1/32"] },
      },
      logging: { level: "info" },
    }),
    ffmpegNeeded: soniox,
  };
}

function onPath(command: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
          stdio: "ignore",
        });
  return probe.status === 0;
}

async function answers(httpPort: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${httpPort}/`, {
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

const INSTALL_HINT =
  "Install the LiveKit server: `brew install livekit` on macOS, `curl -sSL https://get.livekit.io | bash` on Linux, or the livekit-server release from https://github.com/livekit/livekit/releases on Windows. Voice cannot connect until livekit-server is on PATH.";

export async function runDevLiveKit(
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const plan = planDevLiveKit(environment);
  if (plan.action === "skip") {
    console.log(plan.reason);
    return 0;
  }
  if (plan.ffmpegNeeded && !(onPath("ffmpeg") && onPath("ffprobe")))
    console.warn(
      "Recording needs ffmpeg and ffprobe on PATH; install them to save recordings.",
    );
  if (await answers(plan.httpPort)) {
    console.log(
      `A LiveKit server already answers on port ${plan.httpPort}; using it.`,
    );
    return 0;
  }
  if (!onPath("livekit-server")) {
    console.warn(INSTALL_HINT);
    return 0;
  }
  const child = spawn("livekit-server", ["--config-body", plan.config], {
    // The keys stay out of the command line.
    env: { ...environment, LIVEKIT_KEYS: plan.keys },
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => child.kill(signal));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 0 : (code ?? 1)));
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runDevLiveKit(process.env);
