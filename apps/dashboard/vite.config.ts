import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages/]
    }
  },
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime"]
  },
  ssr: {
    noExternal: ["@mui/*", "@emotion/*"]
  },
  optimizeDeps: {
    include: ["@mui/*", "@emotion/*"],
    force: true
  },
  server: {
    port: 3030,
    strictPort: true
  },
  envPrefix: "DASHBOARD_"
});
