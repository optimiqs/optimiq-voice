import { Box } from "@mui/material";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { CreateAgentForm } from "./create-agent.form";
import { useCreateAgent } from "./create-agent.hook";
import type { Route } from "./+types/create-agent.page";

/**
 * Page metadata for the "Create Agent" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Create New Agent | Optimiq Voice" },
		{
			name: "description",
			content:
				"A SIP Agent represents a user or device that connects to your SIP Domain using VoIP.",
		},
	];
}

/**
 * CreateAgent component.
 *
 * Page component for creating a new voice agent.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering agent details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create Agent page.
 */
export default function CreateAgent() {
	/** Custom hook to create a agent via API with optimistic updates. */
	const { onGoBack, onSave } = useCreateAgent();

	/**
	 * Renders the Create Agent page layout.
	 */
	return (
		<FormProvider>
			<Page variant="form">
				<PageHeader
					title="Create New Agent"
					description="A SIP Agent represents a user or device that connects to your SIP Domain using VoIP."
					onBack={{ label: "Back to agents", onClick: onGoBack }}
					actions={
						<FormSubmitButton size="small" loadingText="Saving...">
							Save Agent
						</FormSubmitButton>
					}
				/>

				{/* Form container with a max width for readability and consistent layout */}
				<Box sx={{ maxWidth: "440px" }}>
					<CreateAgentForm onSubmit={onSave} />
				</Box>
			</Page>
		</FormProvider>
	);
}
