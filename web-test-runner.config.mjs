import { esbuildPlugin } from "@web/dev-server-esbuild";

export default {
  debug: false,
  files: "packages/sdk/test/integration/web.integration.ts",
  plugins: [
    esbuildPlugin({
      ts: true
    })
  ],
  nodeResolve: true
};
