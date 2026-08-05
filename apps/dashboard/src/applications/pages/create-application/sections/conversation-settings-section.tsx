import { Box } from "@mui/material";
import { FormField, FormControl, FormItem } from "~/core/components/design-system/forms";
import { Input } from "~/core/components/design-system/ui/input/input";
import { Textarea } from "~/core/components/design-system/ui/textarea/textarea";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { SYSTEM_PROMPT_MIN_ROWS } from "~/core/constants";
import type { Schema } from "../schemas/application-schema";
import type { Control } from "react-hook-form";

export const ConversationSettingsSection = ({
	control,
}: {
	control: Control<Schema>;
	isAutopilot: boolean;
}) => (
	<>
		<Box sx={{ mt: "8px" }}>
			<Typography variant="mono-medium" color="base.03">
				Conversation Settings
			</Typography>
			<Typography variant="body-micro" color="base.03">
				Use these settings to configure the conversation with your customers. All the parameters
				will be available to the context of the conversation.
			</Typography>
		</Box>

		<FormField
			control={control}
			name="intelligence.config.conversationSettings.firstMessage"
			render={({ field }) => (
				<FormItem>
					<FormControl>
						<Input type="text" label="First Message" {...field} />
					</FormControl>
				</FormItem>
			)}
		/>
		<FormField
			control={control}
			name="intelligence.config.conversationSettings.systemPrompt"
			render={({ field }) => (
				<FormItem>
					<FormControl>
						<Textarea
							label="System Prompt"
							minRows={SYSTEM_PROMPT_MIN_ROWS}
							maxRows={SYSTEM_PROMPT_MIN_ROWS}
							placeholder="Add your system prompt here"
							{...field}
						/>
					</FormControl>
				</FormItem>
			)}
		/>
		<FormField
			control={control}
			name="intelligence.config.conversationSettings.goodbyeMessage"
			render={({ field }) => (
				<FormItem>
					<FormControl>
						<Input type="text" label="Goodbye Message" {...field} />
					</FormControl>
				</FormItem>
			)}
		/>
		<FormField
			control={control}
			name="intelligence.config.conversationSettings.systemErrorMessage"
			render={({ field }) => (
				<FormItem>
					<FormControl>
						<Input type="text" label="System Error Message" {...field} />
					</FormControl>
				</FormItem>
			)}
		/>
	</>
);
