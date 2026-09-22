import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://loadpath.dev",
  vite: {
    plugins: [tailwindcss()],
  },
});
