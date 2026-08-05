export interface Workspace {
  id: string;
  name: string;
}

export interface SidebarItem {
  label: string;
  href: string;
  items?: SidebarItem[];
}
