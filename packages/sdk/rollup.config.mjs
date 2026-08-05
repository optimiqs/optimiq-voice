import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const webConfig = {
  input: "src/web.ts",
  output: [
    {
      file: "dist/web/optimiq-voice.min.js",
      format: "umd",
      name: "SDK",
      exports: "auto"
    },
    {
      file: "dist/web/index.esm.js",
      format: "es"
    }
  ],
  plugins: [
    replace({
      "process.env.NODE_ENV": JSON.stringify("browser"),
      preventAssignment: true
    }),
    typescript({
      tsconfig: "./tsconfig.web.json",
      exclude: ["src/client/Client.ts", "src/generated/node/*"]
    }),
    commonjs(),
    resolve({
      browser: true
    }),
    terser({
      format: {
        comments: false
      }
    })
  ]
};

export default [webConfig];
