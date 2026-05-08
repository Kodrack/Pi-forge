# Svelte 5 — Failure Patterns

## State
- `$state` on a primitive that needs reassignment: wrap in object — `const s = $state({ value: 0 })` not `$state(0)`
- Mutate the object property, never reassign the const: `s.value++` not `s = { value: 1 }`

## Reactivity
- `$derived` MUST access `$state` objects directly — calling a function that reads state breaks tracking
  - WRONG: `const items = $derived(getItems())` where `getItems()` reads a $state store
  - RIGHT: `const items = $derived(myStore.list)`
- `$effect` runs after mount — don't use for initial derived values, use `$derived` instead

## Components
- Props use `$props()` not `export let`: `const { title }: { title: string } = $props()`
- Event handlers: `onclick` not `on:click`
- Snippets replace slots: `{#snippet name()}{/snippet}` and `{@render name()}`

## Stores / Module Files
- Store files using runes must end in `.svelte.ts`
- `tsconfig.json` needs `"allowImportingTsExtensions": true` and `"noEmit": true`
- Import with full extension: `import { store } from './store.svelte.ts'`

## Common White Screen Causes
1. Missing `allowImportingTsExtensions` in tsconfig
2. `$derived` calling a function wrapper instead of accessing state directly
3. `export let` instead of `$props()` in components
4. Reassigning a `const $state` primitive instead of mutating the wrapper object
