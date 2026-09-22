# loadpath

Short, opinionated thought dives on engineering decisions — not "how to build
Twitter," but the nuanced calls underneath: when a boundary is load-bearing,
when it's decoration, and what breaks first when you get it wrong.

Starting with **System Design** at [`/system-design`](src/content/system-design).
**Coding** and **LLD** are scaffolded as future subject silos
([`src/content/coding`](src/content/coding), [`src/content/lld`](src/content/lld))
with no routes live yet — they'll get pages once there's content to serve.

## Stack

- [Astro](https://astro.build) with content collections — each note is a
  Markdown file with frontmatter (`title`, `description`, `publishDate`, `tags`)
- Tailwind CSS v4 via `@tailwindcss/vite`
- Deployed to Cloudflare Pages, git-connected — push to `main` builds and
  deploys automatically. Build command `npm run build`, output directory
  `dist`.

## Adding a note

Drop a new Markdown file in `src/content/system-design/`, matching the
frontmatter shape in the existing note. It's picked up automatically — no
route file to touch.

## Local dev

```bash
npm install
npm run dev
```
