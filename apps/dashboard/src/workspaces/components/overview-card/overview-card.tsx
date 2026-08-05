import { Icon } from "~/core/components/design-system/icons/icons";
import { Typography } from "~/core/components/design-system/ui/typography/typography";
import { OverviewCardRootIcon, OverviewCardRootLabel, OverviewCardRoot } from "./overview.styles";
import type { ReactNode } from "react";

export interface OverviewCardProps {
	icon: ReactNode;
	label: string;
	onClick: VoidFunction;
}

export const OverviewCard = (props: OverviewCardProps) => {
	const { label, icon, onClick } = props;

	return (
		<OverviewCardRoot onClick={onClick}>
			<OverviewCardRootIcon>{icon}</OverviewCardRootIcon>

			<OverviewCardRootLabel>
				<Typography
					variant="body-medium"
					sx={{
						color: "base.03",
						overflow: "hidden",
						display: "-webkit-box",
						WebkitBoxOrient: "vertical",
						WebkitLineClamp: 1,
					}}
				>
					{label}
				</Typography>
			</OverviewCardRootLabel>

			<Icon name="ChevronRight" sx={{ color: "base.02", fontSize: "20px" }} />
		</OverviewCardRoot>
	);
};
