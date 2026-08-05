import fs from "fs";
import { BASE_DIR } from "../constants";
import { WorkspaceConfig } from "./types";

function saveConfig(path: string, config: WorkspaceConfig[]): void {
	if (!fs.existsSync(BASE_DIR)) {
		fs.mkdirSync(BASE_DIR, { recursive: true });
	}
	fs.writeFileSync(path, JSON.stringify(config, null, 2));
}

export { saveConfig };
