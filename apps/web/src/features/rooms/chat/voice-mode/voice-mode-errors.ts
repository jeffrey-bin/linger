/** Transport loss after a successful open; the controller reconnects only for this type. */
export class VoiceModeDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceModeDisconnectedError";
  }
}
