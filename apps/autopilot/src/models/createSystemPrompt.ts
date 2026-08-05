import { TelephonyContext } from ".";

function createSystemPrompt(params: {
	firstMessage?: string;
	systemPrompt: string;
	telephonyContext: TelephonyContext;
}) {
	const { firstMessage: firstMessageFromSystem, systemPrompt } = params;
	const { ingressNumber, callerNumber, callDirection, metadata } = params.telephonyContext;
	const additionalParameters = Object.entries(metadata ?? {})
		.map(([key, value]) => `- ${key}: ${value}`)
		.join("\n");

	return `
${systemPrompt}

[Context Information]
{context}

[Call Details]
- System's First Message: ${firstMessageFromSystem}
- Current Time: ${new Date().toISOString()}
- Service Number: ${ingressNumber}
- Caller Number: ${callerNumber}
- Call Direction: ${callDirection}

${
	additionalParameters
		? `[Additional Parameters (metadata)]
${additionalParameters}`
		: ""
}
  `;
}

export { createSystemPrompt };
