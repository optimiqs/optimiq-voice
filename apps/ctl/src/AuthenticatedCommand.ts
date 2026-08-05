import { Command } from "@oclif/core";
import * as SDK from "@optimiq-voice/sdk";
import { BaseCommand } from "./BaseCommand"; // Adjust the import based on your structure
import { getActiveWorkspace, getConfig } from "./config";
import { CONFIG_FILE } from "./constants";

export abstract class AuthenticatedCommand<
  T extends typeof Command
> extends BaseCommand<T> {
  protected async createSdkClient(): Promise<SDK.Client> {
    const workspaces = getConfig(CONFIG_FILE);
    const activeWorkspace = getActiveWorkspace(workspaces);

    if (!activeWorkspace) {
      throw new Error(
        "No active workspace found. Please login to a Workspace."
      );
    }

    try {
      const client = new SDK.Client({
        endpoint: activeWorkspace.endpoint,
        accessKeyId: activeWorkspace.workspaceAccessKeyId,
        allowInsecure: this.flags.insecure
      });

      await client.loginWithApiKey(
        activeWorkspace.accessKeyId,
        activeWorkspace.accessKeySecret
      );

      return client;
    } catch (error) {
      this.error(
        "Failed to initialize the SDK client. Please try by login to the Workspace again.",
        { exit: 1 }
      );
    }
  }
}
