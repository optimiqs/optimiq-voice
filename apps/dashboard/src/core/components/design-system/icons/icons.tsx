import { ICON } from "./icons.const";
import type { IconProps } from "./icons.interfaces";

export function Icon({ fontSize = "medium", name, ...props }: IconProps) {
	const Component = ICON[name];

	if (!Component) return null;

	return <Component {...props} fontSize={fontSize} />;
}
