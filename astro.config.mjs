import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Update once the Cloudflare Pages project exists, in case "loadpath" is
  // taken and Pages assigns a different *.pages.dev subdomain.
  site: "https://loadpath.pages.dev",
  vite: {
    plugins: [tailwindcss()],
  },
});
