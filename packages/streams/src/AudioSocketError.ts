import { ErrorCode } from "./types";

class AudioSocketError extends Error {
  constructor(public errorCode: ErrorCode) {
    super(AudioSocketError.getMessageFromCode(errorCode));
    this.name = "AudioSocketError";
  }

  static getMessageFromCode(errorCode: ErrorCode): string {
    switch (errorCode) {
      case ErrorCode.NONE:
        return "No error";
      case ErrorCode.AST_HANGUP:
        return "Asterisk hangup";
      case ErrorCode.AST_FRAME_FORWARDING:
        return "Asterisk frame forwarding";
      case ErrorCode.AST_MEMORY:
        return "Asterisk memory";
      default:
        return "Unknown error";
    }
  }
}

export { AudioSocketError };
