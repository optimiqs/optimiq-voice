import { LogoLarge } from "./logo-large";
import { LogoSmall } from "./logo-small";

export interface LogoProps {
	size?: "micro" | "large";
}

export function Logo({ size = "large" }: LogoProps) {
	return size === "large" ? <LogoLarge /> : <LogoSmall />;
}
