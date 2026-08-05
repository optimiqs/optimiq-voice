"use client";

import { Menu as BaseMenu } from "@base-ui/react/menu";
import { cn } from "~/lib/cn";
import type { ComponentProps } from "react";

/**
 * Dropdown menu over Base UI.
 *
 * Base UI supplies the roving-tabindex keyboard model, typeahead, the `menu`/`menuitem` roles and
 * the focus return on close. `MenuLinkItem` exists because a menu entry that navigates must be a
 * real anchor — a `menuitem` that is secretly a `<button>` calling `router.push` cannot be
 * middle-clicked, opened in a new tab, or previewed by anything that reads links.
 */

export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuGroup = BaseMenu.Group;

const popupClassName = cn(
	"min-w-[var(--anchor-width)] max-w-[min(20rem,var(--available-width))] origin-[var(--transform-origin)]",
	"rounded-panel border border-border bg-surface p-1 shadow-popover",
	"transition-[opacity,transform] duration-[--motion-fast] ease-[--ease-standard]",
	"data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
	"data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
);

const itemClassName = cn(
	"flex cursor-default items-center gap-2 rounded-[calc(var(--radius-field)-0.125rem)] px-2 py-1.5 text-sm text-foreground outline-none select-none",
	"data-[highlighted]:bg-hover",
	"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
	"[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
);

export function MenuContent({
	className,
	sideOffset = 6,
	align = "start",
	children,
	...props
}: ComponentProps<typeof BaseMenu.Popup> & {
	sideOffset?: number;
	align?: "start" | "center" | "end";
}) {
	return (
		<BaseMenu.Portal>
			<BaseMenu.Positioner sideOffset={sideOffset} align={align} className="z-50 outline-none">
				<BaseMenu.Popup className={cn(popupClassName, className)} {...props}>
					{children}
				</BaseMenu.Popup>
			</BaseMenu.Positioner>
		</BaseMenu.Portal>
	);
}

export function MenuItem({ className, ...props }: ComponentProps<typeof BaseMenu.Item>) {
	return <BaseMenu.Item className={cn(itemClassName, className)} {...props} />;
}

export function MenuLinkItem({ className, ...props }: ComponentProps<typeof BaseMenu.LinkItem>) {
	return <BaseMenu.LinkItem className={cn(itemClassName, className)} {...props} />;
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof BaseMenu.GroupLabel>) {
	return (
		<BaseMenu.GroupLabel
			className={cn("px-2 py-1.5 text-xs font-medium text-subtle-foreground", className)}
			{...props}
		/>
	);
}

export function MenuSeparator({ className, ...props }: ComponentProps<"hr">) {
	return <hr className={cn("my-1 h-px border-0 bg-border", className)} {...props} />;
}
