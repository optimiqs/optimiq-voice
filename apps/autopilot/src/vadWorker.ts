import { join } from "path";
import { parentPort, workerData } from "worker_threads";
import { SileroVad } from "./vad/SileroVad";

const vad = new SileroVad({
	...workerData,
	pathToModel: join(__dirname, "..", "silero_vad_v5.onnx"),
});

vad.init().then(() => {
	// Send ready message to parent
	parentPort?.postMessage("VAD_READY");

	parentPort?.on("message", (chunk) => {
		vad.processChunk(chunk, (voiceActivity) => {
			parentPort?.postMessage(voiceActivity);
		});
	});
});
