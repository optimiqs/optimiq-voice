import { Modal } from "~/core/components/design-system/ui/modal/modal";
import { CreateWorkspaceForm } from "./create-workspace.form";

/**
 * Props for the CreateWorkspaceModal component.
 *
 * @property {boolean} isOpen - Controls the visibility of the modal.
 * @property {() => void} onClose - Function to close the modal.
 */
export interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
}

/**
 * CreateWorkspaceModal component
 *
 * A modal dialog that contains the CreateWorkspaceForm.
 * When the form is successfully submitted, the modal automatically closes.
 *
 * @param {ModalProps} props - Props controlling the modal state.
 * @returns {JSX.Element} The rendered modal with the workspace creation form.
 */
export const CreateWorkspaceModal = ({ isOpen, onClose }: ModalProps) => {
	return (
		<Modal open={isOpen} onClose={onClose} title="Create workspace">
			<CreateWorkspaceForm onFormSubmit={onClose} />
		</Modal>
	);
};
