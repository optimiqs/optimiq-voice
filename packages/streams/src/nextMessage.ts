import { Readable } from "stream";
import { Message } from "./Message";
import { MINIMUM_MESSAGE_LENGTH } from "./types";

async function nextMessage(stream: Readable): Promise<Message> {
  const hdr = Buffer.alloc(MINIMUM_MESSAGE_LENGTH);
  const bytesRead = (await stream.read(MINIMUM_MESSAGE_LENGTH)) as Buffer;

  if (bytesRead.length !== MINIMUM_MESSAGE_LENGTH) {
    throw new Error(
      `Read wrong number of bytes (${bytesRead.length}) for header`
    );
  }

  hdr.set(bytesRead);

  const payloadLen = hdr.readUInt16BE(1);

  if (payloadLen < 1) return new Message(hdr);

  const payload = Buffer.alloc(payloadLen);
  const payloadRead = (await stream.read(payloadLen)) as Buffer;

  if (payloadRead.length !== payloadLen) {
    throw new Error(
      `Read wrong number of bytes (${payloadRead.length}) for payload`
    );
  }

  payload.set(payloadRead);

  return new Message(Buffer.concat([hdr, payload]));
}

export { nextMessage };
