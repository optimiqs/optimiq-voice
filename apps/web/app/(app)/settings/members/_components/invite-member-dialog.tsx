"use client";

import { useForm } from "@tanstack/react-form";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { SelectField, TextField } from "~/components/ui/form-fields";
import { FormFooter } from "~/components/ui/form-footer";
import { ASSIGNABLE_ROLE_TEMPLATES } from "~/lib/permissions";
import { useInviteMember } from "../../../_hooks/use-organization-queries";
import { defaultInviteMemberValues, inviteMemberSchema } from "../invite-member-schema";

export function InviteMemberDialog({
	organizationId,
	open,
	onOpenChange,
}: {
	organizationId: string | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const invite = useInviteMember(organizationId);

	const form = useForm({
		defaultValues: defaultInviteMemberValues,
		validators: { onChange: inviteMemberSchema, onSubmit: inviteMemberSchema },
		onSubmit: async ({ value }) => {
			const parsed = inviteMemberSchema.parse(value);
			await invite.mutateAsync({ email: parsed.email, role: parsed.role });
			form.reset();
			onOpenChange(false);
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
				>
					<DialogHeader>
						<DialogTitle>Invite a member</DialogTitle>
						<DialogDescription>
							They will receive an email with a link that expires in seven days. Re-inviting the
							same address cancels the previous invitation.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-4">
						<form.Field name="email">
							{(field) => (
								<TextField
									field={field}
									label="Email"
									type="email"
									required
									autoFocus
									disabled={invite.isPending}
								/>
							)}
						</form.Field>

						<form.Field name="role">
							{(field) => (
								<>
									<SelectField field={field} label="Role" required disabled={invite.isPending}>
										{ASSIGNABLE_ROLE_TEMPLATES.map((template) => (
											<option key={template.id} value={template.id}>
												{template.label}
											</option>
										))}
									</SelectField>
									<p className="-mt-2 text-xs text-muted-foreground">
										{ASSIGNABLE_ROLE_TEMPLATES.find((template) => template.id === field.state.value)
											?.description ?? ""}
									</p>
								</>
							)}
						</form.Field>
					</div>

					<DialogFooter>
						<FormFooter
							onCancel={() => onOpenChange(false)}
							submitLabel="Send invitation"
							loadingLabel="Sending"
							loading={invite.isPending}
						/>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
