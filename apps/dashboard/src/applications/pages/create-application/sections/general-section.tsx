import { FormField, FormControl, FormItem } from "~/core/components/design-system/forms";
import { Input } from "~/core/components/design-system/ui/input/input";
import { ResourceIdField } from "~/core/components/design-system/ui/resource-id-field/resource-id-field";
import { Select } from "~/core/components/design-system/ui/select/select";
import { APPLICATION_TYPES } from "../create-application.const";
import type { Schema } from "../schemas/application-schema";
import type { Control } from "react-hook-form";

export const GeneralSection = ({
	control,
	isAutopilot,
	isEdit,
	initialValues,
}: {
	control: Control<Schema>;
	isAutopilot: boolean;
	isEdit?: boolean;
	initialValues?: Schema;
}) => (
	<>
		{/* Application ID - Only show in edit mode */}
		{isEdit && initialValues?.ref && (
			<ResourceIdField value={initialValues.ref} label="Application Ref" />
		)}

		<FormField
			control={control}
			name="name"
			render={({ field }) => (
				<FormItem>
					<FormControl>
						<Input type="text" label="Friendly Name" {...field} />
					</FormControl>
				</FormItem>
			)}
		/>

		{!isEdit && (
			<FormField
				control={control}
				name="type"
				render={({ field }) => (
					<FormItem>
						<FormControl>
							<Select label="Application Type" options={APPLICATION_TYPES} {...field} />
						</FormControl>
					</FormItem>
				)}
			/>
		)}

		<FormField
			control={control}
			name="endpoint"
			rules={{ required: !isAutopilot }}
			render={({ field }) => (
				<FormItem>
					<FormControl>
						<Input
							type="text"
							label="Application Endpoint"
							placeholder="your-app.com:50051"
							supportingText="This is your application's endpoint. You only need to specify it for External applications or when running your own instance of the Autopilot service."
							{...field}
						/>
					</FormControl>
				</FormItem>
			)}
		/>
	</>
);
