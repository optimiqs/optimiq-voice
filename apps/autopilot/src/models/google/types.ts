import { BaseModelParams } from "../types";

enum GoogleModel {
  GEMINI_2_0_FLASH = "gemini-2.0-flash",
  GEMINI_2_0_FLASH_LITE = "gemini-2.0-flash-lite",
  GEMINI_2_5_PRO = "gemini-2.5-pro",
  GEMINI_2_5_FLASH = "gemini-2.5-flash",
  GEMINI_2_5_FLASH_LITE = "gemini-2.5-flash-lite",
  GEMINI_3_PRO_PREVIEW = "gemini-3-pro-preview",
  GEMINI_3_FLASH_PREVIEW = "gemini-3-flash-preview"
}

type GoogleParams = BaseModelParams & {
  model: GoogleModel;
  apiKey: string;
  maxTokens: number;
  temperature: number;
};

export { GoogleModel, GoogleParams };
