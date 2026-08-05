import { createContext, useCallback, useContext } from "react";
import type { SidebarItem } from "./sidebar.interfaces";

export interface SidebarContextProps {
  navigate: (href: string) => void;
  pathname: string;
  isItemActive: (item: SidebarItem) => boolean;
  isForcedOpen: (item: SidebarItem) => boolean;
}

export interface SidebarProviderProps {
  navigate: (href: string) => void;
  pathname: string;
  children: React.ReactNode;
}

export const SidebarContext = createContext<SidebarContextProps | null>(null);

export const SidebarProvider = ({
  children,
  navigate,
  pathname
}: SidebarProviderProps) => {
  const isItemActive = useCallback(
    ({ href, items }: SidebarItem) => {
      if (href === pathname) return true;

      if (items) {
        return items.some((child) => pathname.includes(child.href));
      }

      return false;
    },
    [pathname]
  );

  const isForcedOpen = useCallback(
    ({ items }: SidebarItem) => {
      if (!items) return false;

      const isActive = items.some((child) => pathname.includes(child.href));

      return isActive;
    },
    [pathname]
  );

  return (
    <SidebarContext.Provider
      value={{ isItemActive, isForcedOpen, navigate, pathname }}
    >
      {children}
    </SidebarContext.Provider>
  );
};

export const useSidebar = () => {
  const context = useContext(SidebarContext);

  if (!context) {
    throw new Error("useSidebar() must be used within a <SidebarProvider />");
  }

  return context;
};
