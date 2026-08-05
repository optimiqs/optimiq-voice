import { Help } from "@oclif/core";
import figlet from "figlet";

export default class CustomHelp extends Help {
	protected showRootHelp(): Promise<void> {
		this.showLogo();

		this.log(this.formatRoot());
		this.log("");

		this.log(this.formatCommands(this.customCommands));
		this.log("");

		return Promise.resolve();
	}

	private showLogo() {
		this.log("\x1b[32m");
		this.log(
			figlet.textSync("Optimiq Voice", {
				horizontalLayout: "default",
				verticalLayout: "default",
				width: 60,
				whitespaceBreak: true,
			}),
		);
		this.log("\x1b[0m");
	}

	private get customCommands() {
		return this.sortedCommands
			.filter((c) => c.id)
			.sort((a, b) => (a.id.includes(":") ? 1 : b.id.includes(":") ? -1 : 0));
	}
}
