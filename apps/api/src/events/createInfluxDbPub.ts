import { InfluxDB, Point } from "@influxdata/influxdb-client";
import { getLogger } from "@optimiq-voice/logger";

type InfluxDbPub = {
  url: string;
  token: string;
  org: string;
  bucket: string;
};

type OptimiqVoiceEvent = {
  name: "cdr" | "error";
  tag: string;
  data: Record<string, unknown>;
};

const logger = getLogger({ service: "api", filePath: __filename });

function createInfluxDbPub(config) {
  const { url, token, org, bucket } = config;

  logger.info("creating influxdb client", { url, org, bucket });

  const client = new InfluxDB({ url, token });
  const writeClient = client.getWriteApi(org, bucket, "ns");

  return {
    async publish(event: OptimiqVoiceEvent) {
      logger.verbose("writing event to InfluxDB", event);
      const point = new Point(event.name).tag("callId", event.tag);

      Object.entries(event.data).forEach(([key, value]) => {
        if (typeof value === "number") {
          point.intField(key, value);
        } else if (typeof value === "boolean") {
          point.booleanField(key, value);
        } else if (key === "startedAt" || key === "endedAt") {
          point.stringField(key, new Date(value.toString()).getTime());
        } else {
          point.stringField(key, String(value));
        }
      });

      writeClient.writePoint(point);
      await writeClient.flush();
    },
    async close() {
      await writeClient.close();
    }
  };
}

export { OptimiqVoiceEvent, InfluxDbPub, createInfluxDbPub };
