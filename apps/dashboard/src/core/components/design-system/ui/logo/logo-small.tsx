import { memo } from "react";

export const LogoSmall = memo(() => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M16 7.50972C16 3.36194 12.4183 -0.000488281 8 -0.000488281C3.58172 -0.000488281 0 3.36194 0 7.50972V15.9995H7.47826C12.1847 15.9995 16 12.4178 16 7.99951V7.50972Z"
      fill="#39E19E"
    />
    <path
      d="M5.73047 11.8018V4.72046H11.212V6.15667H7.59554V7.68265H10.5751V9.00916H7.59554V11.8018H5.73047Z"
      fill="#333333"
    />
  </svg>
));

LogoSmall.displayName = "LogoSmall";
