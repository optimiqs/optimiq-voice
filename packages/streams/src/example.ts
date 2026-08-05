import { getLogger } from "@optimiq-voice/logger";
import { AudioSocket, AudioStream, StreamRequest } from ".";

const logger = getLogger({ service: "streams", filePath: __filename });

const PORT = 9092;

const audioSocket = new AudioSocket();

async function connectionHandler(req: StreamRequest, stream: AudioStream) {
  const { ref } = req;
  logger.verbose("new connection", { ref });

  // Do something with the data (e.g. save it to a file, or send it to a transcription service)
  // stream.onData((_data) => { /* save on a file or send to a transcription service */ });

  stream.onClose(() => {
    logger.verbose("stream closed");
  });

  stream.onError((err) => {
    logger.error("stream error", err);
  });

  const filePath = process.cwd() + "/etc/sounds/test.sln";

  logger.verbose("playing sound", { filePath });

  await stream.play(filePath);

  // Hangup the stream after 10 seconds
  setTimeout(async () => {
    logger.verbose("hanging up the stream", { ref });
    stream.hangup();
  }, 10000);
}

audioSocket.listen(PORT, () => {
  logger.info(`audiosocket listening on port ${PORT}`);
});

audioSocket.onConnection(connectionHandler);
