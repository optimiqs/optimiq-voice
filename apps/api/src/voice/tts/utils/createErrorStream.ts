import { Readable } from "stream";

function createErrorStream(errorMessage: string): Readable {
  const errorStream = new Readable({ read() {} });
  errorStream.emit("error", new Error(errorMessage));
  errorStream.push(null);
  return errorStream;
}

export { createErrorStream };
