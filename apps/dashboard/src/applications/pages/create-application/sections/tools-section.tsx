import { Box } from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import { useFieldArray } from "react-hook-form";
import { FormField, FormControl, FormItem } from "~/core/components/design-system/forms";
import { Select } from "~/core/components/design-system/ui/select/select";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { ModalTrigger } from "~/core/components/general/modal-trigger";
import { AllowedHttpMethod } from "../schemas/tool-schema";
import { CreateToolModal } from "../tooling/create-tool.modal";
import type { Schema } from "../schemas/application-schema";
import type { Control } from "react-hook-form";

export interface ToolsSectionProps {
	control: Control<Schema>;
}

export interface ToolModalSchema {
	name: string;
	description: string;
	requestStartMessage?: string;
	parameters: {
		type: "object" | "array";
		properties: {
			key: string;
			type: string;
			format?: "enum" | "date-time";
			pattern?: string;
		}[];
		required: string[];
	};
	operation: {
		method: AllowedHttpMethod;
		url: string;
		waitForResponse: boolean;
		headers: { key: string; value: string }[];
	};
}

export const ToolsSection = ({ control }: ToolsSectionProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [initialTool, setInitialTool] = useState<ToolModalSchema | null>(null);

	const {
		fields: tools,
		append,
		remove,
	} = useFieldArray<Schema>({
		control,
		name: "intelligence.config.languageModel.tools",
	});

	const toolValues = useMemo(() => tools.map((tool) => tool.name as string), [tools]);

	const toolOptions = useMemo(
		() =>
			tools.map((tool) => ({
				value: tool.name as string,
				label: tool.name as string,
			})),
		[tools],
	);

	const handleDelete = useCallback(
		(oldValues: string[], newValues: string[]) => {
			const deleted = oldValues.find((val) => !newValues.includes(val));
			if (!deleted) return;

			const idx = tools.findIndex((tool) => tool.name === deleted);
			if (idx !== -1) remove(idx);
		},
		[tools, remove],
	);

	const handleOpenModal = useCallback(() => {
		setIsOpen(true);
	}, []);

	const handleCloseModal = useCallback(() => {
		setIsOpen(false);
		setEditingIndex(null);
		setInitialTool(null);
	}, []);

	const handleToolSubmit = useCallback(
		(tool: ToolModalSchema) => {
			const existingIndex = tools.findIndex(
				(t, i) => t.name === tool.name && i !== (editingIndex ?? -1),
			);

			if (existingIndex !== -1) {
				toast("Tool name must be unique");
				return;
			}

			if (editingIndex != null) {
				// Update existing tool
				const updatedTools = [...tools];
				updatedTools[editingIndex] = tool as any;

				// Remove and re-add to maintain order
				remove(editingIndex);
				updatedTools.forEach((t) => append(t));
			} else {
				// Add new tool
				append(tool as any);
			}

			handleCloseModal();
		},
		[tools, editingIndex, append, remove, handleCloseModal],
	);

	return (
		<>
			<Box sx={{ mt: "8px" }}>
				<Typography variant="mono-medium" color="base.03">
					Tools
				</Typography>
				<Typography variant="body-micro" color="base.03">
					Define callable tools for your Language Model. Use the button below to add tools.
				</Typography>
			</Box>

			<FormField
				control={control}
				name="intelligence.config.languageModel.tools"
				render={() => (
					<FormItem>
						<FormControl>
							<Box sx={{ display: "flex", flexDirection: "column", gap: "12px" }}>
								<Select
									label="Language Model Tools"
									placeholder="Click below to add tools"
									multiple
									value={toolValues}
									options={toolOptions}
									disabled
									onChange={(event) => {
										const newValues = event.target.value as string[];
										handleDelete(toolValues, newValues);
									}}
								/>

								<ModalTrigger label="Add Tool" onClick={handleOpenModal} />
							</Box>
						</FormControl>
					</FormItem>
				)}
			/>

			<CreateToolModal
				isOpen={isOpen}
				onClose={handleCloseModal}
				initialValues={initialTool ?? undefined}
				onFormSubmit={(data: unknown) => handleToolSubmit(data as ToolModalSchema)}
			/>
		</>
	);
};
