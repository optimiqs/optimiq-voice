import { Box } from "@mui/material";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { FormProvider } from "~/core/contexts/form-context";
import { CreateDomainForm } from "./create-domain.form";
import { useCreateDomain } from "./create-domain.hook";
import type { Route } from "./+types/create-domain.page";

/**
 * Page metadata for the "Create Domain" page.
 *
 * Sets the page title and description for SEO and browser tabs.
 *
 * @param _ - Meta arguments provided by the router (not used here).
 * @returns An array of metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Create New Domain | Optimiq Voice" },
		{
			name: "description",
			content:
				"A SIP Domain is used to group multiple SIP Agents for internal calling and organization.",
		},
	];
}

/**
 * CreateDomain component.
 *
 * Page component for creating a new voice domain.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for entering domain details.
 *  - Save action to submit the form.
 *
 * @returns {JSX.Element} The rendered Create Domain page.
 */
export default function CreateDomain() {
	/** Custom hook to create a domain via API with optimistic updates. */
	const { onGoBack, onSave } = useCreateDomain();

	/**
	 * Renders the Create Domain page layout.
	 */
	return (
		<FormProvider>
			<Page variant="form">
				<PageHeader
					title="Create New Domain"
					description="A SIP Domain is used to group multiple SIP Agents for internal calling and organization."
					onBack={{ label: "Back to domains", onClick: onGoBack }}
					actions={
						<FormSubmitButton size="small" loadingText="Saving...">
							Save Domain
						</FormSubmitButton>
					}
				/>

				{/* Form container with a max width for readability and consistent layout */}
				<Box sx={{ maxWidth: "440px" }}>
					<CreateDomainForm onSubmit={onSave} />
				</Box>
			</Page>
		</FormProvider>
	);
}
