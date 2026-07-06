import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// `base: "./"` makes all asset URLs relative, so the build works whether it is
// served from a GitHub Pages *project* site (https://user.github.io/<repo>/) or
// a user/custom-domain site. No router is used, so a single index.html is enough.
//
// nodePolyfills provides Buffer/process/global that some wallet-connector
// dependencies (WalletConnect, Argent mobile) expect to exist in the browser.
export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
