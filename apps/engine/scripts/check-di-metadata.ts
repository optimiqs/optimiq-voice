// Proves the runner this script is executed under emits `design:paramtypes`, by walking the whole
// api module graph. Offline: only decorator metadata is read, nothing is instantiated or connected.
import "reflect-metadata";
import { assertResolvableModuleGraph } from "../../../.scripts/check-di-metadata.mjs";
import { AppModule } from "../src/app.module";

assertResolvableModuleGraph(AppModule, "engine");
