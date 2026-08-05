import { Command } from "@oclif/core";

export default class Bug extends Command {
	static override description = "report a bug to the development team 🐞";
	static override examples = ["<%= config.bin %> <%= command.id %>"];

	public async run(): Promise<void> {
		const link =
			" https://github.com/optimiqs/optimiq-voice/issues/new?assignees=&labels=bug&projects=&template=bug_report.yaml&title=%5BBUG%5D%3A+";
		this.log(`Please report bugs to the link below:\n${link}`);
	}
}
