import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `base: "./"` makes all asset URLs relative, so the build works whether it is
// served from a GitHub Pages *project* site (https://user.github.io/<repo>/) or
// a user/custom-domain site. No router is used, so a single index.html is enough.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
