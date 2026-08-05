import { createContext, useContext, useState } from "react";
import type {
  ApplicationContextValue,
  ApplicationProviderProps
} from "./application.interfaces";

export const ApplicationContext = createContext<ApplicationContextValue | null>(
  null
);

export const ApplicationProvider = ({ children }: ApplicationProviderProps) => {
  const [application, setApplication] = useState({ ref: "" });

  return (
    <ApplicationContext.Provider value={{ application, setApplication }}>
      {children}
    </ApplicationContext.Provider>
  );
};

export const useApplicationContext = () => {
  const context = useContext(ApplicationContext);

  if (!context) {
    throw new Error(
      "useApplication() must be used within an <ApplicationProvider />"
    );
  }

  return context;
};
