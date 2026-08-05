const MINIMUM_MESSAGE_LENGTH = 3;
const MAXIMUM_MESSAGE_LENGTH = 65535;

enum MessageType {
	HANGUP = 0x00,
	ID = 0x01,
	SILENCE = 0x02,
	SLIN = 0x10,
	ERROR = 0xff,
}

enum ErrorCode {
	NONE = 0x00,
	AST_HANGUP = 0x01,
	AST_FRAME_FORWARDING = 0x02,
	AST_MEMORY = 0x04,
	UNKNOWN = 0xff,
}

enum EventType {
	DATA = "data",
	END = "end",
	ERROR = "error",
}

type StreamRequest = {
	ref: string;
};

export {
	ErrorCode,
	EventType,
	MAXIMUM_MESSAGE_LENGTH,
	MINIMUM_MESSAGE_LENGTH,
	MessageType,
	StreamRequest,
};
