// Proves the runner this script is executed under emits `design:paramtypes`, by walking the api's
// feature module graphs. Offline: only decorator metadata is read, nothing is instantiated or
// connected.
//
// `AppModule` is deliberately empty — `main.ts` composes the feature modules onto it, conditionally,
// each gated on its own database URL — so the modules it would mount are listed here instead.
import "reflect-metadata";
import { assertResolvableModuleGraph } from "../../../.scripts/check-di-metadata.mjs";
import { CdrModule } from "../src/cdr/cdr.module";
import { LiveModule } from "../src/live/live.module";
import { PbxCdrPortsModule } from "../src/pbx/pbx-cdr-ports.module";
import { PbxModule } from "../src/pbx/pbx.module";
import { ProvisioningModule } from "../src/provisioning/provisioning.module";
import { SessionModule } from "../src/session/session.module";

assertResolvableModuleGraph(
	[PbxModule, ProvisioningModule, LiveModule, SessionModule, CdrModule, PbxCdrPortsModule],
	"api",
);
