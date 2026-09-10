"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { PageHeader } from "~/components/ui/page-header";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTrigger } from "~/components/ui/tabs";
import { COMPLIANCE_TABS, type ComplianceTab } from "~/lib/routes";
import { CompliancePolicyPanel } from "./compliance-policy-panel";
import { KycPanel } from "./kyc-panel";
import { VerifiedCallerIdsPanel } from "./verified-caller-ids-panel";

/**
 * Who this organization is, and which caller IDs it may present.
 *
 * Three panels on one page rather than three routes, on the same terms as the numbers screen: they
 * are three parts of one question a carrier asks, and splitting them would mean three sidebar
 * entries all meaning "compliance" and three `PAGE_PERMISSIONS` lines saying `compliance.read`.
 *
 * The policy tab is visible to anyone who can read this page and gates its own save on
 * `settings.write` — the cascade is a settings grant, not a compliance one. Hiding the tab from a
 * compliance officer would hide the existence of the two settings that decide what their verified
 * caller IDs are actually FOR.
 */
const TAB_LABELS: Readonly<Record<ComplianceTab, string>> = {
	kyc: "Know your customer",
	"caller-ids": "Verified caller IDs",
	policy: "Outbound policy",
};

export function ComplianceScreen() {
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(COMPLIANCE_TABS).withDefault("kyc").withOptions({ clearOnDefault: true }),
	);

	return (
		<>
			<PageHeader
				title="Compliance"
				description="What this organization tells its carriers about itself, and what an outbound call is allowed to claim as its caller ID."
			/>

			<Tabs value={tab} onValueChange={(next) => void setTab(next as ComplianceTab)}>
				<TabsList>
					{COMPLIANCE_TABS.map((value) => (
						<TabsTrigger key={value} value={value}>
							{TAB_LABELS[value]}
						</TabsTrigger>
					))}
					<TabsIndicator />
				</TabsList>

				<TabsPanel value="kyc">
					<KycPanel />
				</TabsPanel>
				<TabsPanel value="caller-ids">
					<VerifiedCallerIdsPanel />
				</TabsPanel>
				<TabsPanel value="policy">
					<CompliancePolicyPanel />
				</TabsPanel>
			</Tabs>
		</>
	);
}
