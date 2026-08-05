import { customAlphabet } from "nanoid";

function generateAccessKeySecret() {
  return customAlphabet(
    "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    64
  )();
}

export { generateAccessKeySecret };
