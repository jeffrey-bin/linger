import { main } from "../../../src/main.js";

// The real entrypoint, with a Room request timeout short enough for a stalled
// TeamHub claim to time out within the test.
await main({ agentRoomRequestTimeoutMs: 250 });
