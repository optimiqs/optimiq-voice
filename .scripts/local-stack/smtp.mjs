import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startTestSmtp } from "../fixtures/smtp-test-server.mjs";

// The mail sink as a standing service. The fixture keeps messages in memory, which is enough for a
// single-process harness and nothing for a stack whose test client is a separate process, so each
// captured message is also written to $MAIL_DIR as a numbered .eml the smoke test can read.
const port = Number(process.env.SMTP_PORT ?? 2625);
const directory = resolve(process.env.MAIL_DIR ?? "./mail");
mkdirSync(directory, { recursive: true });
const smtp = await startTestSmtp({ port });
console.log(JSON.stringify({ event: "smtp_listening", port, directory }));
let written = 0;
setInterval(() => {
	while (written < smtp.messages.length) {
		const message = smtp.messages[written];
		writeFileSync(resolve(directory, `${String(written).padStart(4, "0")}.eml`), `${message.recipient}\r\n${message.body}`);
		written += 1;
		console.log(JSON.stringify({ event: "smtp_captured", index: written, recipient: message.recipient }));
	}
}, 200);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void smtp.close().then(() => process.exit(0)));
