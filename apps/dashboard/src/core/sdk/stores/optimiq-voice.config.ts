const { origin, hostname, port } = new URL(
	import.meta.env.DASHBOARD_API_URL || "https://api.optimiq.health",
);

export const OPTIMIQ_VOICE_CLIENT_CONFIG = Object.freeze({
	url: origin,
	accessKeyId: "",
	allowInsecure: Boolean(import.meta.env.DASHBOARD_ALLOW_INSECURE === "true"),
});

export const OPTIMIQ_VOICE_SERVER_CONFIG = Object.freeze({
	endpoint: `${hostname}${port ? `:${port}` : ""}`,
	accessKeyId: "",
	allowInsecure: Boolean(import.meta.env.DASHBOARD_ALLOW_INSECURE === "true"),
	accessToken: "",
});

export const OPTIMIQ_VOICE_RESET_PASSWORD_URL: string =
	import.meta.env.DASHBOARD_RESET_PASSWORD_URL || "https://app.optimiq.health/auth/reset-password";

export const IS_CLOUD = Boolean(import.meta.env.DASHBOARD_EDITION === "cloud");
export const IS_PRIVATE_BETA = Boolean(import.meta.env.DASHBOARD_PRIVATE_BETA_ENABLED === "true");
export const IS_SIGNUP_ENABLED = IS_CLOUD && !IS_PRIVATE_BETA;
