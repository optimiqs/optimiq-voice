import { Modal } from "~/core/components/design-system/ui/modal/modal";
import { InviteMemberForm } from "./invite-member.form";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const InviteMemberModal = ({ isOpen, onClose }: ModalProps) => {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Invite a new member to your workspace."
    >
      <InviteMemberForm onClose={onClose} />
    </Modal>
  );
};
