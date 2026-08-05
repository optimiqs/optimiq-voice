function isJwtExpired(token: string) {
  try {
    const [, payloadBase64] = token.split(".");

    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf8");
    const payload = JSON.parse(payloadJson);

    if (!payload.exp) {
      return false;
    }

    const expirationTime = payload.exp * 1000;
    const currentTime = Date.now();

    return currentTime > expirationTime;
  } catch (error) {
    return true;
  }
}

export { isJwtExpired };
