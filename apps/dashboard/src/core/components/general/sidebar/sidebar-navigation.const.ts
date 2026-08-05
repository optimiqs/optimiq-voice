import { useMemo } from "react";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import type { SidebarItem } from "./sidebar.interfaces";

export const SIDEBAR_ITEMS = Object.freeze<SidebarItem[]>([
  { label: "Overview", href: "/workspaces/[workspaceId]" },
  { label: "Applications", href: "/workspaces/[workspaceId]/applications" },
  {
    label: "SIP Network",
    href: "",
    items: [
      {
        label: "Trunks",
        href: "/workspaces/[workspaceId]/sip-network/trunks"
      },
      {
        label: "Numbers",
        href: "/workspaces/[workspaceId]/sip-network/numbers"
      },
      {
        label: "Domains",
        href: "/workspaces/[workspaceId]/sip-network/domains"
      },
      {
        label: "Agents",
        href: "/workspaces/[workspaceId]/sip-network/agents"
      },
      {
        label: "ACLs",
        href: "/workspaces/[workspaceId]/sip-network/acls"
      },
      {
        label: "Credentials",
        href: "/workspaces/[workspaceId]/sip-network/credentials"
      }
    ]
  },
  // { label: "Storage", href: "/workspaces/[workspaceId]/storage" },
  { label: "Secrets", href: "/workspaces/[workspaceId]/secrets" },
  { label: "API Keys", href: "/workspaces/[workspaceId]/api-keys" },
  { label: "Monitoring", href: "/workspaces/[workspaceId]/monitoring" }
]);

export const withWorkspaceId = (url: string, workspaceId: string) => {
  return url.replace(/\[workspaceId\]/g, workspaceId);
};

export const useSidebarItems = () => {
  const workspaceId = useWorkspaceId();

  return useMemo(
    () =>
      SIDEBAR_ITEMS.map((item) => {
        if (item.items) {
          return {
            ...item,
            items: item.items.map((subItem) => ({
              ...subItem,
              href: withWorkspaceId(subItem.href, workspaceId)
            }))
          };
        }

        return { ...item, href: withWorkspaceId(item.href, workspaceId) };
      }),
    [workspaceId]
  );
};
