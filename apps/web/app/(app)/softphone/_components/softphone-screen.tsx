"use client";

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { PageHeader } from "~/components/ui/page-header";
import { SoftphoneDialer } from "../../_components/softphone/softphone-dialer";
import { useSoftphone } from "../../_context/softphone-context";

export function SoftphoneScreen() {
	const phone = useSoftphone();

	return (
		<>
			<PageHeader
				title="Softphone"
				description="Make and receive calls using your assigned extension."
			/>

			<div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
				<Card>
					<CardBody>
						<SoftphoneDialer />
					</CardBody>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Calling from your browser</CardTitle>
						<CardDescription>Go online to receive calls on your extension.</CardDescription>
					</CardHeader>
					<CardBody className="space-y-4 text-sm text-foreground">
						<p className="text-muted-foreground">
							Allow microphone access when prompted, and keep this browser open while you are
							online. Use headphones to reduce echo during calls.
						</p>
						<p className="text-muted-foreground">
							Dial an extension to reach a colleague, or enter a phone number using your
							organization&apos;s dialing rules. During a call, you can mute your microphone, put
							the caller on hold, or use the keypad.
						</p>
						{!phone.webrtcSupported && (
							<output className="block text-muted-foreground">{phone.mediaNote}</output>
						)}
					</CardBody>
				</Card>
			</div>
		</>
	);
}
