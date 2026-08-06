"use client";

import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cn } from "~/lib/cn";
import { focusRing } from "./focus-ring";
import type { ComponentProps } from "react";

/**
 * Tabs over Base UI.
 *
 * Base UI owns the roving tabindex, the arrow-key model and the `aria-controls` wiring between a
 * tab and its panel. The indicator is a real element positioned from the active tab's box rather
 * than a border on the tab itself, so it can animate between them.
 *
 * Tabs are for sibling views of ONE subject — inbound and outbound routes are both "routing".
 * Two unrelated pages behind a tab strip is navigation wearing a tab costume; those get routes.
 */

export const Tabs = BaseTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
	return (
		<BaseTabs.List
			className={cn(
				"relative flex w-full items-center gap-1 overflow-x-auto border-b border-border",
				className,
			)}
			{...props}
		/>
	);
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
	return (
		<BaseTabs.Tab
			className={cn(
				"relative -mb-px shrink-0 cursor-default rounded-t-field px-3 py-2 text-sm font-medium whitespace-nowrap",
				"text-muted-foreground transition-colors duration-[--motion-fast] ease-[--ease-standard]",
				"hover:text-foreground data-[selected]:text-foreground",
				focusRing,
				className,
			)}
			{...props}
		/>
	);
}

export function TabsIndicator({ className, ...props }: ComponentProps<typeof BaseTabs.Indicator>) {
	return (
		<BaseTabs.Indicator
			className={cn(
				"absolute bottom-0 left-0 z-10 h-0.5 w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] bg-primary",
				"transition-[transform,width] duration-[--motion-base] ease-[--ease-emphasized]",
				className,
			)}
			{...props}
		/>
	);
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
	return <BaseTabs.Panel className={cn("flex flex-col gap-6 pt-6", className)} {...props} />;
}
