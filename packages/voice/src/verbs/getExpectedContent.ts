import { toCamelCase } from "@optimiq-voice/common";

function getExpectedContent(name: string) {
	switch (name) {
		case "StartStreamGather":
			return "startStreamGatherResponse";
		case "StartStream":
			return "startStreamResponse";
		default:
			return `${toCamelCase(name)}Response`;
	}
}

export { getExpectedContent };
