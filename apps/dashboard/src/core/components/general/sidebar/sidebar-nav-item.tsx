import { ExpandLess, ExpandMore } from "@mui/icons-material";
import { Collapse } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import SubNavItem from "./sidebar-subnav-item";
import { useSidebar } from "./sidebar.context";
import {
  SidebarNavItemContent,
  SidebarNavItemRoot,
  SidebarNavItemSubMenu,
  SidebarNavItemText
} from "./sidebar.styles";
import type { SidebarItem } from "./sidebar.interfaces";

export interface NavItemProps {
  item: SidebarItem;
}

const NavItem = ({ item }: NavItemProps) => {
  const { href, items: nestedItems } = item;
  const { isForcedOpen, isItemActive, navigate } = useSidebar();

  const [isOpen, setOpen] = useState(false);
  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);

  const onClickEvent = useCallback(() => {
    if (nestedItems) return handleToggle();

    navigate(href);
  }, [href, nestedItems, navigate, handleToggle]);

  useEffect(() => {
    setOpen(isForcedOpen(item));
  }, [isForcedOpen, item]);

  return (
    <>
      <SidebarNavItemRoot
        onClick={onClickEvent}
        data-selected={isItemActive(item)}
      >
        <SidebarNavItemContent data-selected={isItemActive(item)}>
          <SidebarNavItemText
            variant="drawer-label"
            data-selected={isItemActive(item)}
          >
            {item.label}
          </SidebarNavItemText>
          {nestedItems &&
            (isOpen ? (
              <ExpandLess sx={{ color: "base.04" }} />
            ) : (
              <ExpandMore sx={{ color: "base.04" }} />
            ))}
        </SidebarNavItemContent>
      </SidebarNavItemRoot>
      {nestedItems && (
        <Collapse in={isOpen} timeout="auto" unmountOnExit>
          <SidebarNavItemSubMenu>
            {nestedItems.map((child) => (
              <SubNavItem key={child.label} item={child} />
            ))}
          </SidebarNavItemSubMenu>
        </Collapse>
      )}
    </>
  );
};

export default NavItem;
