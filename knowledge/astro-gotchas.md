# Astro — Failure Patterns

## Component Model
- `.astro` files are server-rendered by default — no client-side JS unless you add a directive
- Interactive components MUST have a client directive or they render as static HTML with no JS:
  - `<Component client:load />` — hydrates immediately
  - `<Component client:visible />` — hydrates when in viewport
  - Forgetting `client:` = component looks right but buttons don't work

## Props
- Access props via `Astro.props` in frontmatter, not `export let` or `$props()`:
  ```astro
  ---
  const { title, count } = Astro.props;
  ---
  ```
- For TypeScript: define interface above and use `interface Props { title: string }`

## Frontmatter
- Code between `---` runs server-side only — no `useState`, no browser APIs (`window`, `document`)
- `fetch()` is fine in frontmatter (server-side)
- Client-side logic goes in `<script>` tags or framework components

## Script Tags
- `<script>` in .astro files is bundled by Vite and runs client-side
- `<script is:inline>` runs as-is, not bundled — use for simple one-off scripts
- Don't mix server variables into client `<script>` directly — use `define:vars` directive:
  ```astro
  <script define:vars={{ myVar }}>console.log(myVar)</script>
  ```

## Reactivity / State
- No built-in reactivity in .astro files — use nanostores for shared client state:
  ```ts
  import { atom } from 'nanostores';
  export const count = atom(0);
  ```
- Or use a framework component (React/Svelte/Vue) with `client:load` for reactive UI

## Routing
- File-based routing: `src/pages/about.astro` → `/about`
- Dynamic routes: `src/pages/[slug].astro` — access via `Astro.params.slug`
- API routes: `src/pages/api/data.ts` — export `GET`, `POST` functions

## Common White Screen / Silent Fail Causes
1. Missing `client:load` on interactive component
2. Using `window`/`document` in frontmatter (server-side — doesn't exist)
3. Trying to import a `.svelte`/`.tsx` component without installing the integration
4. Forgetting `output: 'server'` in astro.config when using SSR
