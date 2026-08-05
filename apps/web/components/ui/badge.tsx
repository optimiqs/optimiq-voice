import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/cn";
import type { ComponentProps } from "react";

const badgeVariants = cva(
	"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
	{
		variants: {
			tone: {
				neutral: "bg-muted text-muted-foreground",
				accent: "bg-accent text-accent-foreground",
				success: "bg-success-subtle text-success",
				warning: "bg-warning-subtle text-warning",
				danger: "bg-danger-subtle text-danger",
			},
		},
		defaultVariants: { tone: "neutral" },
	},
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
	return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
