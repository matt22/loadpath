import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://loadpath.cosmic-lab.workers.dev",
  vite: {
    plugins: [tailwindcss()],
  },
});
