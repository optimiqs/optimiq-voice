import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication
} from "@nestjs/platform-fastify";
import { getLogger } from "@optimiq-voice/logger";
import { AppModule } from "./app.module";
import { HTTP_BRIDGE_PORT } from "./envs";

const logger = getLogger({ service: "api", filePath: __filename });

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter()
  );
  app.enableShutdownHooks();
  await app.listen(HTTP_BRIDGE_PORT, "0.0.0.0");
  logger.info(`HTTP API is running on port ${HTTP_BRIDGE_PORT}`);
}

bootstrap().catch((error) => {
  logger.error("failed to start API", error);
  process.exitCode = 1;
});
