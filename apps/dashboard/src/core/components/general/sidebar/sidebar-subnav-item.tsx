import { useCallback } from "react";
import { useSidebar } from "./sidebar.context";
import { SidebarNavItemContent, SidebarNavItemRoot, SidebarNavItemText } from "./sidebar.styles";
import type { SidebarItem } from "./sidebar.interfaces";

export interface SubNavItemProps {
	item: SidebarItem;
}

const SubNavItem = ({ item }: SubNavItemProps) => {
	const { navigate, isItemActive } = useSidebar();

	const onNavigate = useCallback(() => navigate(item.href), [item.href, navigate]);

	return (
		<SidebarNavItemRoot onClick={onNavigate} data-selected={isItemActive(item)} sx={{ pl: "16px" }}>
			<SidebarNavItemContent data-selected={isItemActive(item)}>
				<SidebarNavItemText variant="drawer-label" data-selected={isItemActive(item)}>
					{item.label}
				</SidebarNavItemText>
			</SidebarNavItemContent>
		</SidebarNavItemRoot>
	);
};

export default SubNavItem;
