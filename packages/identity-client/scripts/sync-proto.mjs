import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The canonical Identity proto lives in @optimiq-voice/common. We copy it at build
// time rather than vendoring a committed copy, so there is a single source.
const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../common/src/protos/identity.proto");
const destDir = resolve(here, "../proto");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, resolve(destDir, "identity.proto"));
console.log("synced identity.proto from @optimiq-voice/common");
