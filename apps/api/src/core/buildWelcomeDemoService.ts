import { StreamEvent, VoiceSessionStreamServer } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "api", filePath: __filename });

const SERVICE_DEFINITION = {
  serviceName: "Voice",
  pckg: "voice",
  version: "v1beta2",
  proto: "voice.proto"
} as const;

function buildWelcomeDemoService() {
  return {
    definition: SERVICE_DEFINITION,
    handlers: {
      createSession: (voice: VoiceSessionStreamServer) => {
        let mediaSessionRef: string | undefined;

        voice.on(
          StreamEvent.DATA,
          (params: {
            request?: { mediaSessionRef: string; callerNumber: string };
            sayResponse?: unknown;
          }) => {
            try {
              const { request, sayResponse } = params;

              if (request) {
                const { callerNumber } = request;
                mediaSessionRef = request.mediaSessionRef;

                logger.verbose("welcome demo session started", {
                  mediaSessionRef,
                  callerNumber
                });

                voice.write({
                  answerRequest: {
                    mediaSessionRef: request.mediaSessionRef
                  }
                });

                voice.write({
                  sayRequest: {
                    text: "Welcome to Optimiq Voice! Your system is configured correctly and ready for voice application development. Goodbye!",
                    mediaSessionRef: request.mediaSessionRef
                  }
                });
              }

              if (sayResponse && mediaSessionRef) {
                logger.verbose("hanging up welcome demo session", {
                  mediaSessionRef
                });
                voice.write({
                  hangupRequest: {
                    mediaSessionRef
                  }
                });
              }
            } catch (error) {
              logger.error("error in welcome demo session", {
                mediaSessionRef,
                error
              });
              if (mediaSessionRef) {
                voice.write({
                  hangupRequest: { mediaSessionRef }
                });
              }
              voice.end();
            }
          }
        );

        voice.once(StreamEvent.END, () => {
          voice.end();
          logger.verbose("welcome demo session ended", { mediaSessionRef });
        });

        voice.on(StreamEvent.ERROR, (error) => {
          logger.error("stream error in welcome demo session", {
            mediaSessionRef,
            error
          });
          voice.end();
        });
      }
    }
  };
}

export { buildWelcomeDemoService };
