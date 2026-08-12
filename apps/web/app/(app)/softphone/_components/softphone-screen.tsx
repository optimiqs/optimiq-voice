"use client";

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { PageHeader } from "~/components/ui/page-header";
import { SoftphoneDialer } from "../../_components/softphone/softphone-dialer";
import { useSoftphone } from "../../_context/softphone-context";

/**
 * The focused softphone page.
 *
 * The docked widget is where the phone actually lives; this page is the place to read what it can
 * and cannot do. It states the media boundary in plain words because the honest answer — "this
 * registers and signals but carries no audio yet" — is exactly the thing a user would otherwise
 * discover by placing a silent call.
 */
export function SoftphoneScreen() {
	const phone = useSoftphone();

	return (
		<>
			<PageHeader
				title="Softphone"
				description="Register your extension in the browser and place calls over the platform's own SIP transport."
			/>

			<div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
				<Card>
					<CardBody>
						<SoftphoneDialer />
					</CardBody>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>What works, and what is still being built</CardTitle>
						<CardDescription>
							The signalling path is complete; the media plane is the remaining piece.
						</CardDescription>
					</CardHeader>
					<CardBody className="space-y-4 text-sm text-foreground">
						<div>
							<p className="font-medium text-foreground">Working today</p>
							<ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
								<li>
									Registration over secure WebSocket (WSS) against sipd, using your extension.
								</li>
								<li>Placing and receiving calls — INVITE, ringing, answer, reject and hang up.</li>
								<li>In-call controls wired to the SIP session: hold, mute and DTMF.</li>
							</ul>
						</div>
						<div>
							<p className="font-medium text-foreground">Not yet — and why</p>
							<p className="mt-1 text-muted-foreground">
								{phone.mediaNote} A browser call negotiates media over WebRTC, which requires
								DTLS-SRTP; the platform&apos;s media daemon (mediad) does not terminate SRTP yet, so
								a call reaches the far end as signalling but no audio flows through the
								platform&apos;s media plane. This surface does not claim otherwise — when
								mediad&apos;s WebRTC leg ships, the same session begins carrying audio with no
								change here.
							</p>
						</div>
					</CardBody>
				</Card>
			</div>
		</>
	);
}
