import { z } from "zod";

const workspaceConfigSchema = z.object({
	endpoint: z.string().min(1, "The endpoint value is required"),
	workspaceAccessKeyId: z.string().min(1, "The workspaceAccessKeyId value is required"),
	accessKeyId: z.string().min(1, "The accessKeyId value is required"),
	accessKeySecret: z.string().min(1, "The accessKeySecret value is required"),
	workspaceRef: z.string().min(1, "The workspaceRef value is required"),
	workspaceName: z.string().min(1, "The workspaceName value is required"),
	active: z.boolean().optional(),
});

export { workspaceConfigSchema };
