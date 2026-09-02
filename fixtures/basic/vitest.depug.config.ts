// Loads depug into this project without editing its own vitest.config.ts:
// import the project's own config, add the depug plugin, done. A test run
// points `--config` at this file instead of the project's own.
import { defineConfig, mergeConfig } from "vitest/config";
import { depugPlugin } from "../../src/plugin.ts";
import baseConfig from "./vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      depugPlugin({
        include: (id) => id.endsWith("/fixtures/basic/src/app.ts"),
      }),
    ],
  }),
);
