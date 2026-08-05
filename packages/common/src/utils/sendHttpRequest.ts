import { URLSearchParams } from "url";
import { z } from "zod";
import { getLogger } from "@optimiq-voice/logger";

const responseSchema = z.object({
  result: z.string()
});

const logger = getLogger({ service: "common", filePath: __filename });

enum AllowedHttpMethod {
  GET = "get",
  POST = "post"
}

async function sendHttpRequest(request: {
  method: AllowedHttpMethod;
  url: string;
  waitForResponse: boolean;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
}): Promise<{ result: string }> {
  const { url, method, params, headers, waitForResponse } = request;
  const effectiveMethod = method.toLowerCase() as AllowedHttpMethod;

  let effectiveUrl = url;
  if (effectiveMethod === AllowedHttpMethod.GET && params) {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      queryParams.append(key, String(value));
    });
    effectiveUrl = `${url}${url.includes("?") ? "&" : "?"}${queryParams.toString()}`;
  }

  const options = {
    method: effectiveMethod,
    headers: {
      ...headers,
      accept: "application/json",
      "content-type": "application/json"
    },
    body:
      effectiveMethod === AllowedHttpMethod.POST
        ? JSON.stringify(params)
        : undefined
  };

  logger.silly(`sending request to ${effectiveUrl}`, {
    params,
    method: effectiveMethod
  });

  if (!waitForResponse && effectiveMethod === AllowedHttpMethod.POST) {
    setTimeout(() => {
      fetch(effectiveUrl, options)
        .then((res) => {
          logger.verbose(
            `fire-and-forget request to ${effectiveUrl} completed`,
            {
              status: res.status,
              ok: res.ok
            }
          );
        })
        .catch((error) => {
          logger.error(`fire-and-forget request to ${effectiveUrl} failed`, {
            error: error instanceof Error ? error.message : error
          });
        });
    }, 0);
    return { result: "success" };
  } else {
    const response = await fetch(effectiveUrl, options);
    const data = await response.json();

    try {
      return responseSchema.parse(data) as { result: string };
    } catch (error) {
      throw new Error(
        `Invalid response: expected ${JSON.stringify(responseSchema, null, 2)}, got ${JSON.stringify(data, null, 2)}`
      );
    }
  }
}

export { sendHttpRequest, AllowedHttpMethod };
