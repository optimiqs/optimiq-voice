import path from "path";
import { Actor, createActor } from "xstate";
import { getLogger } from "@optimiq-voice/logger";
import { machine } from "./machine/machine";
import { AutopilotParams } from "./types";
import { SileroVad, Vad, VadEvent } from "./vad";

const logger = getLogger({ service: "autopilot", filePath: __filename });

class Autopilot {
  private readonly actor: Actor<typeof machine>;
  private vad: Vad;

  constructor(private readonly params: AutopilotParams) {
    const { voice, languageModel, conversationSettings } = this.params;

    this.actor = createActor(machine, {
      input: {
        conversationSettings,
        languageModel,
        voice
      }
    });
  }

  async start() {
    const vadParams = this.params.conversationSettings.vad;
    const sileroVad = new SileroVad({
      pathToModel:
        vadParams.pathToModel ||
        path.resolve(__dirname, "..", "silero_vad_v5.onnx"),
      activationThreshold: vadParams.activationThreshold,
      deactivationThreshold: vadParams.deactivationThreshold,
      debounceFrames: vadParams.debounceFrames
    });

    await sileroVad.init();
    this.vad = sileroVad;

    await this.setupVoiceStream();
    await this.setupSpeechGathering();

    this.actor.start();

    logger.verbose("autopilot is ready");

    this.actor.subscribe((state) => {
      logger.verbose("actor's new state is", { state: state.value });
    });
  }

  stop() {
    logger.verbose("stopping autopilot");
    this.actor.stop();
  }

  private async setupVoiceStream() {
    const { voice } = this.params;
    const stream = await voice.stream();

    stream.onData(this.handleVoicePayload.bind(this));
  }

  private handleVoicePayload(chunk: Uint8Array) {
    try {
      if (!this.vad) {
        logger.error("VAD not initialized");
        return;
      }

      // Process the audio chunk with the VAD directly
      this.vad.processChunk(chunk, (event: VadEvent) => {
        logger.verbose("received speech event from vad", { event });

        if (event === "SPEECH_START") {
          this.actor.send({ type: "SPEECH_START" });
        } else if (event === "SPEECH_END") {
          this.actor.send({ type: "SPEECH_END" });
        }
      });
    } catch (err) {
      logger.error("an error occurred while processing vad", err);
    }
  }

  private async setupSpeechGathering() {
    const { voice } = this.params;
    const stream = await voice.sgather();

    stream.onData((payload: { speech: string; responseTime: number }) => {
      const { speech, responseTime } = payload;

      logger.verbose("received speech result", {
        event: "SPEECH_RESULT",
        speech,
        responseTime
      });

      if (payload.speech) {
        this.actor.send({
          type: "SPEECH_RESULT",
          speech: payload.speech ?? "",
          responseTime
        });
      }
    });
  }
}

export { Autopilot };
