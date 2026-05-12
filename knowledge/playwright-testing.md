# Playwright — Failure Patterns for Local HTML Verification

## Setup
- Import: `const { chromium } = require('playwright');`
- Local files: `await page.goto('file://' + require('path').resolve('index.html'))`
- ALWAYS use `headless: true` for automated verification
- ALWAYS call `browser.close()` in a finally block or the process hangs

## Waiting (the #1 failure)
- NEVER click/fill immediately after goto — wait first: `await page.waitForSelector('#btn')`
- `waitForSelector` throws after 30s by default — use `{ timeout: 5000 }` for fast fail
- After click that triggers DOM change: `await page.waitForSelector('.result')` before asserting
- For animations/transitions: `await page.waitForTimeout(500)` — but prefer `waitForSelector`
- SPAs: `page.goto()` resolves on load, not on JS render — always wait for a visible element

## Locators
- Prefer `page.locator('text=Submit')` over CSS selectors — matches what user sees
- `page.getByRole('button', { name: 'Save' })` is most reliable
- `page.locator('#id')` for exact element — but IDs may not exist in generated HTML
- WRONG: `page.click('.btn')` — deprecated, use `page.locator('.btn').click()`
- Multiple matches: `locator.first()`, `locator.nth(1)` — bare locator throws if ambiguous

## Interactions
- Type into input: `await page.locator('#email').fill('test@test.com')` — NOT `.type()`
- `.fill()` clears first then types. `.type()` appends character by character (slow, rarely needed)
- Checkbox: `await page.locator('#agree').check()` — NOT `.click()`
- Select dropdown: `await page.locator('select').selectOption('value')`
- Keyboard: `await page.keyboard.press('Enter')` — after focusing the right element

## Assertions
- Text visible: `await expect(page.locator('.msg')).toHaveText('Success')`
- Element exists: `await expect(page.locator('#panel')).toBeVisible()`
- Count: `await expect(page.locator('li')).toHaveCount(5)`
- WRONG: reading `innerText` then comparing with `===` — use `expect()` which auto-retries
- `expect()` needs: `const { expect } = require('@playwright/test')` — NOT available in plain scripts
- For plain scripts without test runner: `const text = await page.locator('.msg').innerText(); if (text !== 'ok') throw new Error('fail');`

## Screenshots
- `await page.screenshot({ path: 'result.png', fullPage: true })`
- Specific element: `await page.locator('.card').screenshot({ path: 'card.png' })`

## Verification Script Pattern
```js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + require('path').resolve('index.html'));
    await page.waitForSelector('#app');
    // interactions here
    // assertions here
    console.log('PASS');
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
```

## Common Crashes
1. `browser.close()` missing — Node process hangs forever
2. `file://` path not absolute — blank page, no error
3. Click before waitForSelector — element not found, flaky
4. Using `expect()` in a plain script — throws `expect is not a function`
5. `page.goto()` on SPA then immediate `innerText` — gets empty string, JS hasn't rendered
