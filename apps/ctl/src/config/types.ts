import { z } from "zod";
import { workspaceConfigSchema } from "./validations";

type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export type { WorkspaceConfig };
