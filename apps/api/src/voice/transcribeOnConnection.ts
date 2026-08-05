import { Stream } from "stream";
import { getLogger } from "@optimiq-voice/logger";
import { AudioStream } from "@optimiq-voice/streams";

const logger = getLogger({ service: "api", filePath: __filename });

function transcribeOnConnection(stream: Stream) {
  return async (_, res: AudioStream) => {
    logger.verbose("starting instance of audio stream for transcription");
    res
      .onData((data) => {
        stream.emit("data", data);
      })
      .onError((err) => {
        logger.error("stream error:", err);
      });
  };
}

export { transcribeOnConnection };
