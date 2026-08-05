import fs from "fs";
import { BaseMessage } from "@langchain/core/messages";
import { StreamEvent } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { VoiceRequest, VoiceResponse } from "@optimiq-voice/voice";
import Autopilot, {
	ConversationProvider,
	ConversationSettings,
	LanguageModel,
	S3KnowledgeBase,
	VoiceImpl,
} from ".";
import {
	AWS_S3_ACCESS_KEY_ID,
	AWS_S3_ENDPOINT,
	AWS_S3_REGION,
	AWS_S3_SECRET_ACCESS_KEY,
	CONVERSATION_PROVIDER,
	CONVERSATION_PROVIDER_FILE,
	INTEGRATIONS_FILE,
	KNOWLEDGE_BASE_ENABLED,
	RECORDING_BASE_URL,
	UNSTRUCTURED_API_KEY,
	UNSTRUCTURED_API_URL,
} from "./envs";
import { loadAssistantConfigFromFile } from "./loadAssistantConfigFromFile";
import { loadAssistantFromAPI } from "./loadAssistantFromAPI";
import { createLanguageModel } from "./models/createLanguageModel";
import { EventsHook, sendConversationEndedEvent } from "./sendConversationEndedEvent";

const logger = getLogger({ service: "autopilot", filePath: __filename });

async function handleVoiceRequest(req: VoiceRequest, res: VoiceResponse) {
	const {
		accessKeyId,
		callerNumber,
		ingressNumber,
		mediaSessionRef,
		appRef,
		callRef,
		callDirection,
		metadata,
	} = req;

	logger.verbose("voice request", {
		accessKeyId,
		ingressNumber,
		mediaSessionRef,
		appRef,
		callRef,
		metadata,
	});

	const assistantConfig =
		CONVERSATION_PROVIDER === ConversationProvider.FILE
			? loadAssistantConfigFromFile(CONVERSATION_PROVIDER_FILE)
			: await loadAssistantFromAPI(req, JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, "utf8")));

	let knowledgeBase;

	if (KNOWLEDGE_BASE_ENABLED) {
		const documents = assistantConfig.languageModel?.knowledgeBase?.map(
			(doc) => doc.document,
		) as string[];

		logger.verbose("loading knowledge base", {
			documents,
			bucket: req.accessKeyId.toLowerCase(),
		});

		knowledgeBase = new S3KnowledgeBase({
			bucket: req.accessKeyId.toLowerCase(),
			documents,
			s3Config: {
				endpoint: AWS_S3_ENDPOINT,
				region: AWS_S3_REGION,
				credentials: {
					accessKeyId: AWS_S3_ACCESS_KEY_ID,
					secretAccessKey: AWS_S3_SECRET_ACCESS_KEY,
				},
				forcePathStyle: true,
			},
			unstructuredAPIURL: UNSTRUCTURED_API_URL,
			unstructuredAPIKey: UNSTRUCTURED_API_KEY,
		});
	}

	knowledgeBase?.load().then(() => {
		logger.verbose("knowledge base loaded");
	});

	const voice = new VoiceImpl(mediaSessionRef, res);

	const languageModel = createLanguageModel({
		voice,
		assistantConfig,
		knowledgeBase,
		telephonyContext: {
			callDirection,
			ingressNumber,
			callerNumber,
			metadata,
		},
	});

	const { conversationSettings } = assistantConfig;

	try {
		const autopilot = new Autopilot({
			conversationSettings: conversationSettings as ConversationSettings,
			voice: voice as VoiceImpl,
			languageModel: languageModel as LanguageModel,
		});

		await autopilot.start();

		res.on(StreamEvent.END, async () => {
			autopilot.stop();

			const rawChatHistory = await languageModel.getChatHistoryMessages();
			const chatHistory = rawChatHistory
				.map((msg: BaseMessage) => {
					if (msg.constructor.name === "HumanMessage") {
						return { human: msg.content };
					} else if (msg.constructor.name === "AIMessage") {
						return { ai: msg.content };
					}
					return null;
				})
				.filter(Boolean);

			if (assistantConfig.eventsHook?.url) {
				// Construct recording URL: baseUrl + appRef + mediaSessionRef
				const recordingUrl = `${RECORDING_BASE_URL}/${appRef}_${mediaSessionRef}.wav`;

				await sendConversationEndedEvent(assistantConfig.eventsHook as EventsHook, {
					appRef,
					callRef,
					phone: ingressNumber,
					chatHistory: chatHistory as Record<string, string>[],
					recordingUrl,
				});
			}
		});
	} catch (error) {
		logger.error("error handling voice request", { error });
	}
}

export { handleVoiceRequest };
