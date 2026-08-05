import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  StreamableFile
} from "@nestjs/common";

const RECORDINGS_DIRECTORY = "/opt/optimiq-voice/recordings";

@Controller("api/recordings")
export class RecordingsController {
  @Get(":id")
  async getRecording(@Param("id") id: string) {
    const recordingPath = resolve(RECORDINGS_DIRECTORY, id);
    if (dirname(recordingPath) !== RECORDINGS_DIRECTORY) {
      throw new BadRequestException("Invalid recording ID");
    }

    const recording = await readFile(recordingPath);
    return new StreamableFile(recording, { type: "audio/wav" });
  }
}
