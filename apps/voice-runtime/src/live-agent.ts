import { defineAgent } from "@livekit/agents";
import { loadConfig } from "./config.js";
import { LiveVoiceWorker } from "./live-worker.js";
import { TeamHubVoiceRuntimeClient } from "./live-client.js";
import { XaiLiveSession } from "./xai-live.js";
import { SileroSpeechActivityDetector } from "./voice-activity.js";
import { voicePurposeFromMetadata } from "./livekit-worker.js";
export default defineAgent({
  prewarm: () => SileroSpeechActivityDetector.prewarm(),
  entry: async (ctx) => {
    const config = loadConfig();
    if (voicePurposeFromMetadata(ctx.job.metadata) !== "chat_live")
      throw new Error("Live worker only accepts live sessions");
    if (!config.xaiApiKey) throw new Error("Live voice requires XAI_API_KEY");
    const client = new TeamHubVoiceRuntimeClient(
      config.teamhubBaseUrl,
      config.teamhubToken,
    );
    await new LiveVoiceWorker(
      client,
      (setup) =>
        XaiLiveSession.open({
          apiKey: config.xaiApiKey,
          webSocketUrl: config.xaiLiveWebSocketUrl,
          audioTransport: config.xaiLiveAudioTransport,
          model: "grok-voice-3.0",
          voice: "ara",
          reasoningEffort: "high",
          setup,
        }),
      { startedAt: Date.now() },
    ).run(ctx);
  },
});
