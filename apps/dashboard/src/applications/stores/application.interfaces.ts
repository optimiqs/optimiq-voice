import React from "react";

export interface Application {
	/**
	 * Unique identifier for the application.
	 */
	ref: string;
}

export interface ApplicationProviderProps {
	/**
	 * React children to render within the provider.
	 */
	children: React.ReactNode;
}

export interface ApplicationContextValue {
	application: Application;
	setApplication: (application: Application) => void;
}
