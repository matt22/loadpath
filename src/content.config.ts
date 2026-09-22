import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const noteSchema = z.object({
  title: z.string(),
  description: z.string(),
  publishDate: z.coerce.date(),
  tags: z.array(z.string()).default([]),
});

const systemDesign = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/system-design" }),
  schema: noteSchema,
});

// Not yet populated — routes for these land when there's content to serve.
const coding = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/coding" }),
  schema: noteSchema,
});

const lld = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/lld" }),
  schema: noteSchema,
});

export const collections = { "system-design": systemDesign, coding, lld };
