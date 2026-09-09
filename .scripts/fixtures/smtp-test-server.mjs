import { createServer } from "node:net";

// A local, unauthenticated SMTP sink for disposable acceptance tests. Never forwards mail.
export async function startTestSmtp() {
	const messages = [], sockets = new Set();
	const server = createServer(socket => {
		sockets.add(socket); socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8"); socket.write("220 test.local ESMTP\r\n");
		let buffer = "", inData = false, message = [], recipient = "";
		socket.on("data", data => {
			buffer += data;
			while (buffer.includes("\r\n")) {
				const end = buffer.indexOf("\r\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
				if (inData) {
					if (line === ".") { messages.push({ recipient, body: message.join("\r\n") }); message = []; inData = false; socket.write("250 queued\r\n"); }
					else message.push(line.startsWith("..") ? line.slice(1) : line);
				} else if (/^EHLO|^HELO/i.test(line)) socket.write("250-test.local\r\n250 8BITMIME\r\n");
				else if (/^RCPT TO:/i.test(line)) { recipient = line; socket.write("250 OK\r\n"); }
				else if (/^DATA$/i.test(line)) { inData = true; socket.write("354 send message\r\n"); }
				else if (/^QUIT$/i.test(line)) socket.end("221 bye\r\n");
				else socket.write("250 OK\r\n");
			}
		});
	});
	await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
	return { port: server.address().port, messages, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
