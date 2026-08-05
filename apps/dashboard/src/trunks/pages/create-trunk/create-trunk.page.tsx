import { Box } from "@mui/material";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { CreateTrunkForm } from "./create-trunk.form";
import { useCreateTrunk } from "./create-trunk.hook";
import type { Route } from "./+types/create-trunk.page";

/**
 * Page metadata for the "Create Trunk" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Create New SIP Trunk | Optimiq Voice" },
		{
			name: "description",
			content:
				"A VoIP Provider is a resource within the Optimiq Voice network that handles PSTN connectivity.",
		},
	];
}

/**
 * CreateTrunk component.
 *
 * Page component for creating a new voice trunk.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering trunk details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create Trunk page.
 */
export default function CreateTrunk() {
	/** Custom hook to create a trunk via API with optimistic updates. */
	const { onGoBack, onSave } = useCreateTrunk();

	/**
	 * Renders the Create Trunk page layout.
	 */
	return (
		<FormProvider>
			<Page variant="form">
				<PageHeader
					title="Create New SIP Trunk"
					description="A VoIP Provider is a resource within the Optimiq Voice network that handles PSTN connectivity."
					onBack={{ label: "Back to trunks", onClick: onGoBack }}
					actions={
						<FormSubmitButton size="small" loadingText="Saving...">
							Save SIP Trunk
						</FormSubmitButton>
					}
				/>

				{/* Form container with a max width for readability and consistent layout */}
				<Box sx={{ maxWidth: "440px" }}>
					<CreateTrunkForm onSubmit={onSave} />
				</Box>
			</Page>
		</FormProvider>
	);
}
