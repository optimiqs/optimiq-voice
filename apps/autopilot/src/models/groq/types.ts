import { BaseModelParams } from "../types";

enum GroqModel {
	LLAMA3_3_3_70B_VERSATILE = "llama-3.3-70b-versatile",
}

type GroqParams = BaseModelParams & {
	model: GroqModel;
	apiKey: string;
	maxTokens: number;
	temperature: number;
};

export { GroqModel, GroqParams };
