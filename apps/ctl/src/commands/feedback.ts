import { Command } from "@oclif/core";

export default class Feedback extends Command {
  static override description = `provide feedback on your experience
  ...
  Help us improve by providing some feedback
  `;
  static override examples = ["<%= config.bin %> <%= command.id %>"];

  public async run(): Promise<void> {
    const link =
      " https://docs.google.com/forms/d/e/1FAIpQLSd1G2ahRYqkbksOvz7XhNHfSLepUh3KzRHsXh2HXfZr68nhtQ/viewform?vc=0&c=0&w=1&flr=0";
    this.log(
      `Please provide feedback on your experience by filling out the form below:\n${link}`
    );
  }
}
