import { CallDirection } from "@optimiq-voice/types";

function mapCallDirectionToEnum(direction: string): CallDirection {
  switch (direction) {
    case "from-pstn":
      return CallDirection.FROM_PSTN;
    case "peer-to-pstn":
    case "agent-to-pstn":
      return CallDirection.TO_PSTN;
    case "agent-to-agent":
    case "agent-to-peer":
    case "peer-to-agent":
      return CallDirection.INTRA_NETWORK;
    default:
      throw new Error(`Invalid call direction: ${direction}`);
  }
}

export { mapCallDirectionToEnum };
