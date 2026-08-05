import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Form, FormControl, FormField, FormItem } from "~/core/components/design-system/forms";
import { FormRoot } from "~/core/components/design-system/forms/form-root";
import { Input } from "~/core/components/design-system/ui/input/input";
import { PasswordStrengthBar } from "~/core/components/design-system/ui/password-strength-bar";
import { ResourceIdField } from "~/core/components/design-system/ui/resource-id-field/resource-id-field";
import { useFormContextSync } from "~/core/hooks/use-form-context-sync";
import { schema, type Schema } from "./create-credential.schema";
import type { Credentials } from "@optimiq-voice/types";

/**
 * Props interface for the CreateCredentialForm component.
 */
export interface CreateCredentialFormProps extends React.PropsWithChildren {
	/** Optional initial values to populate the form fields with. */
	initialValues?: Schema;
	/** Callback triggered on successful form submission. */
	onSubmit: (data: Schema) => Promise<Credentials | void | null>;
	/** Whether this form is for editing an existing credential. */
	isEdit?: boolean;
}

/**
 * CreateCredentialForm component.
 *
 * Renders a form for creating a credential, including fields for:
 * - Friendly Name
 * - Username
 * - Password
 *
 * Integrates:
 * - React Hook Form for state management
 * - Zod for schema validation
 * - FormContext for state synchronization
 *
 * @param {CreateCredentialFormProps} props - Props including onSubmit handler and optional initial values.
 * @returns {JSX.Element} The rendered Create Credential form.
 */
export function CreateCredentialForm({
	onSubmit,
	initialValues,
	isEdit,
}: CreateCredentialFormProps) {
	/** Initializes the React Hook Form with Zod validation and initial values. */
	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: initialValues || {
			ref: null,
			name: "",
			username: "",
			password: "",
		},
		mode: "onChange",
	});

	const watchPassword = form.watch("password");

	/** Sync form state with FormContext */
	useFormContextSync(form, onSubmit, isEdit);

	/**
	 * Renders the form with individual fields wrapped in FormField and FormItem components.
	 */
	return (
		<Form {...form}>
			<FormRoot onSubmit={form.handleSubmit(onSubmit)}>
				{/* Credential ID - Only show in edit mode */}
				{isEdit && initialValues?.ref && (
					<ResourceIdField value={initialValues.ref} label="Credential Ref" />
				)}

				{/* Friendly Name Field */}
				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							<FormControl>
								<Input type="text" label="Friendly Name" {...field} />
							</FormControl>
						</FormItem>
					)}
				/>

				{/* Username Field */}
				<FormField
					control={form.control}
					name="username"
					render={({ field }) => (
						<FormItem>
							<FormControl>
								<Input type="text" label="Username" {...field} />
							</FormControl>
						</FormItem>
					)}
				/>

				{/* Password Field */}
				<FormField
					control={form.control}
					name="password"
					render={({ field }) => (
						<FormItem>
							<FormControl>
								<Input type="password" label="Password" {...field} />
								<PasswordStrengthBar password={watchPassword || ""} />
							</FormControl>
						</FormItem>
					)}
				/>
			</FormRoot>
		</Form>
	);
}
