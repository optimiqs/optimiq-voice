import { GoBackButton } from "../../design-system/ui/go-back/go-back";
import {
	PageHeaderDescriptionText,
	PageHeaderRoot,
	PageHeaderRow,
	PageHeaderTitleContainer,
	PageHeaderTitleText,
} from "./page-header.styles";
import type { ReactNode, FC } from "react";

export interface PageHeaderProps {
	title: string;
	description?: string;
	actions?: ReactNode;
	onBack?: {
		label: string;
		onClick: VoidFunction;
	};
}

export const PageHeader: FC<PageHeaderProps> = ({ title, description, actions, onBack }) => {
	return (
		<PageHeaderRoot>
			{onBack && <GoBackButton {...onBack} />}
			<PageHeaderRow>
				<PageHeaderTitleContainer>
					<PageHeaderTitleText variant="heading-medium" color="base.03">
						{title}
					</PageHeaderTitleText>
					{description && (
						<PageHeaderDescriptionText variant="body-small" color="base.03">
							{description}
						</PageHeaderDescriptionText>
					)}
				</PageHeaderTitleContainer>
				{actions}
			</PageHeaderRow>
		</PageHeaderRoot>
	);
};
