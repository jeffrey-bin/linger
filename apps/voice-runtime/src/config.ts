import { serviceCredential } from "@linger/service-kit/node";

export interface VoiceRuntimeConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  teamhubBaseUrl: string;
  teamhubToken: string;
  sonioxApiKey: string;
  xaiApiKey: string;
  xaiLiveWebSocketUrl: string;
  xaiLiveAudioTransport?: "binary" | "json";
  initializeProcessTimeoutMs: number;
}

// LIVEKIT_* default to the LiveKit service of the root docker-compose.yml on
// its published port; TeamHub reads the same names with the same defaults.
const livekitDefaults = {
  LIVEKIT_URL: "ws://127.0.0.1:17880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "devsecret-livekit-voice-local-only-32-bytes",
};
// Built-in constants; not configurable per deployment. TeamHub's archive
// recovery uses the same Soniox language hints.
export const healthPort = Number(process.env.VOICE_WORKER_PORT ?? 4324);
if (!Number.isInteger(healthPort) || healthPort < 1024 || healthPort > 65535)
  throw new Error("VOICE_WORKER_PORT is invalid");
export const maxSessions = 16;
const initializeProcessTimeoutMs = 60_000;
export const sonioxRealtimeModel = "stt-rt-v5";
// Hints bias short openings that sound alike across languages (a Mandarin
// greeting vs. "Hallo") without excluding other languages.
export const sonioxLanguageHints = ["zh", "en"];

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): VoiceRuntimeConfig => {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const withDefault = (name: keyof typeof livekitDefaults) =>
    env[name] || livekitDefaults[name];
  const audioTransport =
    env.VOICE_RUNTIME_XAI_LIVE_AUDIO_TRANSPORT?.trim() || undefined;
  if (
    audioTransport !== undefined &&
    audioTransport !== "binary" &&
    audioTransport !== "json"
  )
    throw new Error(
      "VOICE_RUNTIME_XAI_LIVE_AUDIO_TRANSPORT must be binary or json",
    );
  const config: VoiceRuntimeConfig = {
    livekitUrl: withDefault("LIVEKIT_URL"),
    livekitApiKey: withDefault("LIVEKIT_API_KEY"),
    livekitApiSecret: withDefault("LIVEKIT_API_SECRET"),
    teamhubBaseUrl: required("TEAMHUB_BASE_URL"),
    teamhubToken:
      serviceCredential("voice-runtime", env) ?? required("LINGER_SECRET_SEED"),
    // Each provider key turns on only its own workers: Soniox transcribes,
    // xAI runs Live.
    sonioxApiKey: env.SONIOX_API_KEY?.trim() ?? "",
    xaiApiKey: env.XAI_API_KEY?.trim() ?? "",
    xaiLiveWebSocketUrl:
      env.VOICE_RUNTIME_XAI_LIVE_WEBSOCKET_URL?.trim() ||
      "wss://api.x.ai/v1/realtime",
    xaiLiveAudioTransport: audioTransport,
    initializeProcessTimeoutMs,
  };
  validateUrl(config.livekitUrl, ["ws:", "wss:"], "LIVEKIT_URL");
  // Like TeamHub, LIVEKIT_URL is an origin: the API URL is derived from it.
  if (!["", "/"].includes(new URL(config.livekitUrl).pathname)) {
    throw new Error("LIVEKIT_URL is invalid");
  }
  validateUrl(config.teamhubBaseUrl, ["http:", "https:"], "TEAMHUB_BASE_URL");
  validateUrl(
    config.xaiLiveWebSocketUrl,
    ["ws:", "wss:"],
    "VOICE_RUNTIME_XAI_LIVE_WEBSOCKET_URL",
  );
  return config;
};

export const calculateWorkerLoad = (activeJobs: number, maxSessions: number) =>
  activeJobs / maxSessions;

const validateUrl = (raw: string, protocols: string[], name: string) => {
  const url = new URL(raw);
  if (
    !protocols.includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} is invalid`);
  }
};
