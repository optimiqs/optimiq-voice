"use client";

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { BuildingIcon } from "~/components/ui/icons";
import { useAppSession } from "../_context/session-context";
import { CreateOrganizationDialog } from "./create-organization-dialog";

/**
 * What a signed-in user sees before they belong to any organization.
 *
 * Two ways out and no third: create one, or wait for an invitation. There is no "browse" state to
 * offer — organizations are tenants, and one is only reachable by membership.
 */
export function NoOrganization() {
	const session = useAppSession();
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<main id="main" className="flex min-h-dvh items-center justify-center bg-canvas px-6 py-12">
			<div className="w-full max-w-lg">
				<EmptyState
					icon={<BuildingIcon className="size-5" />}
					title="Set up your organization"
					description={`Signed in as ${session.user.email}. An organization holds your extensions, numbers and call history. Create one, or ask an administrator to invite you to theirs.`}
					action={
						<Button variant="primary" onClick={() => setCreateOpen(true)}>
							Create an organization
						</Button>
					}
				/>
			</div>
			<CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
		</main>
	);
}
