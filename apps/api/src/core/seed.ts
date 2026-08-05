import { getLogger } from "@optimiq-voice/logger";
import { db } from "./db";

const logger = getLogger({ service: "api", filePath: __filename });

async function main() {
	await db.product.upsert({
		where: { ref: "tts.google" },
		update: {},
		create: {
			ref: "tts.google",
			name: "Google Text-to-Speech",
			vendor: "GOOGLE",
			type: "TTS",
		},
	});

	await db.product.upsert({
		where: { ref: "stt.google" },
		update: {},
		create: {
			ref: "stt.google",
			name: "Google Speech-to-Text",
			vendor: "GOOGLE",
			type: "STT",
		},
	});

	await db.product.upsert({
		where: { ref: "stt.deepgram" },
		update: {},
		create: {
			ref: "stt.deepgram",
			name: "Deepgram Speech-to-Text",
			vendor: "DEEPGRAM",
			type: "STT",
		},
	});

	await db.product.upsert({
		where: { ref: "tts.deepgram" },
		update: {},
		create: {
			ref: "tts.deepgram",
			name: "Deepgram Text-to-Speech",
			vendor: "DEEPGRAM",
			type: "TTS",
		},
	});

	await db.product.upsert({
		where: { ref: "tts.elevenlabs" },
		update: {},
		create: {
			ref: "tts.elevenlabs",
			name: "Eleven Labs Text-to-Speech",
			vendor: "ELEVEN_LABS",
			type: "TTS",
		},
	});

	await db.product.upsert({
		where: { ref: "tts.azure" },
		update: {},
		create: {
			ref: "tts.azure",
			name: "Azure Text-to-Speech",
			vendor: "MICROSOFT",
			type: "TTS",
		},
	});

	await db.product.upsert({
		where: { ref: "llm.openai" },
		update: {},
		create: {
			ref: "llm.openai",
			name: "OpenAI Language Model",
			vendor: "OPENAI",
			type: "LLM",
		},
	});

	await db.product.upsert({
		where: { ref: "llm.groq" },
		update: {},
		create: {
			ref: "llm.groq",
			name: "Groq Language Model",
			vendor: "GROQ",
			type: "LLM",
		},
	});

	await db.product.upsert({
		where: { ref: "llm.anthropic" },
		update: {},
		create: {
			ref: "llm.anthropic",
			name: "Anthropic Language Model",
			vendor: "ANTHROPIC",
			type: "LLM",
		},
	});

	await db.product.upsert({
		where: { ref: "llm.google" },
		update: {},
		create: {
			ref: "llm.google",
			name: "Google Language Model",
			vendor: "GOOGLE",
			type: "LLM",
		},
	});
}

main()
	.then(async () => {
		await db.close();
	})
	.catch(async (e) => {
		logger.error(e);
		await db.close();
		process.exit(1);
	});
