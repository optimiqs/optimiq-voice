"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/field";
import { toast } from "~/components/ui/toast";
import { fetchSettingCategory, patchSettingCategory } from "~/lib/org-settings/client";
import { pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { RequirePermission } from "../../_components/require-permission";
import { useActiveOrganization, useAppSession } from "../../_context/session-context";

export function SipDomainSettings() {
	const organizationId = useActiveOrganization()?.id ?? "";
	const { permissions } = useAppSession();
	const canEdit = permissions.includes("settings.write");
	const queryClient = useQueryClient();
	const key = queryKeys.orgSettingsCategory(organizationId, "sip");
	const [draft, setDraft] = useState<string>();
	const settings = useQuery({
		queryKey: key,
		queryFn: () => fetchSettingCategory("sip"),
		enabled: organizationId.length > 0 && permissions.includes("settings.read"),
	});
	const saved = typeof settings.data?.data.realm === "string" ? settings.data.data.realm : "";
	const value = draft ?? saved;
	const normalized = value.trim().toLowerCase();
	const valid =
		normalized === "" ||
		(normalized.length <= 253 &&
			normalized
				.split(".")
				.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)));
	const save = useMutation({
		mutationFn: (realm: string) => patchSettingCategory("sip", { realm: realm || null }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: key });
			setDraft(undefined);
			toast.success("SIP domain saved");
		},
		onError: (error) => toast.error(pbxToastMessage(error, "SIP domain was not saved")),
	});
	return (
		<RequirePermission permissions={["settings.read"]}>
			<Card>
				<CardHeader>
					<CardTitle>Calling domain</CardTitle>
					<CardDescription>
						Give this organization a unique SIP domain for its phones. Point its DNS records to your
						SIP server before provisioning devices.
					</CardDescription>
				</CardHeader>
				<CardBody>
					{settings.isError ? (
						<p role="alert">{pbxToastMessage(settings.error, "Could not load the SIP domain")}</p>
					) : (
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (canEdit && valid && normalized !== saved && !save.isPending) {
									save.mutate(normalized);
								}
							}}
						>
							<label className="block space-y-2 text-sm" htmlFor="organization-sip-domain">
								<span>SIP domain</span>
								<Input
									id="organization-sip-domain"
									value={value}
									onChange={(event) => setDraft(event.target.value)}
									placeholder="acme.voice.example.com"
									disabled={!canEdit || settings.isPending || save.isPending}
									autoComplete="off"
									spellCheck={false}
									aria-invalid={!valid}
									aria-describedby="sip-domain-help"
									className="max-w-md"
								/>
							</label>
							<p id="sip-domain-help" className="text-sm text-muted-foreground">
								{valid
									? "Changing the domain requires phones to be provisioned again. Leave it empty to remove the assignment."
									: "Enter a domain without a scheme, port or trailing dot."}
							</p>
							{canEdit && (
								<Button
									type="submit"
									variant="primary"
									loading={save.isPending}
									disabled={!valid || settings.isPending || normalized === saved}
								>
									Save calling domain
								</Button>
							)}
						</form>
					)}
				</CardBody>
			</Card>
		</RequirePermission>
	);
}
