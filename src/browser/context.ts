/**
 * Browser context manager.
 * Manages a singleton persistent Chromium browser context for session persistence.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { HermesClient, HermesUnavailableError } from '../hermes-client.js';

const DEFAULT_USER_DATA_DIR = resolve(homedir(), '.freetaxusa-mcp', 'browser-profile');
const TAX_YEAR = process.env.FREETAXUSA_TAX_YEAR ?? '2025';

export const BASE_URL = `https://www.freetaxusa.com/taxes${TAX_YEAR}/taxcontrol`;
export const AUTH_URL = `https://auth.freetaxusa.com/?PRMPT&appYear=${TAX_YEAR}`;

/** Domains the FreeTaxUSA login session spans; used to scope injected cookies. */
const SESSION_COOKIE_DOMAINS = ['.freetaxusa.com', 'www.freetaxusa.com', 'auth.freetaxusa.com'];

/**
 * Hermes is the AUTHORITATIVE auth path when HERMES_URL/HERMES_CLIENT_TOKEN are
 * set: the broker performs the FreeTaxUSA login on the host and hands back a
 * fresh cookie session. When Hermes is configured but unavailable, seeding
 * fails LOUDLY rather than silently dropping to the embedded Playwright login —
 * that silent fallback would defeat the intent (Hermes owns the login).
 *
 * Escape hatch: FREETAXUSA_LEGACY_AUTH=true opts back into the embedded
 * Playwright login even when Hermes is configured-but-down.
 */
function isLegacyAuthEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.FREETAXUSA_LEGACY_AUTH ?? '');
}

/** True when Hermes is configured as the auth source for this server. */
export function isHermesConfigured(): boolean {
  return HermesClient.fromEnv('freetaxusa') !== null;
}

let browserContext: BrowserContext | null = null;
let activePage: Page | null = null;

/**
 * Async mutex to prevent concurrent page operations.
 */
let mutexPromise: Promise<void> = Promise.resolve();
let mutexResolve: (() => void) | null = null;

export async function acquirePageLock(): Promise<() => void> {
  // Wait for any existing lock
  await mutexPromise;

  // Create new lock
  let resolve: () => void;
  mutexPromise = new Promise<void>(r => {
    resolve = r;
  });
  mutexResolve = resolve!;

  return () => {
    mutexResolve = null;
    resolve!();
  };
}

function ensureUserDataDir(): string {
  const dir = process.env.FREETAXUSA_USER_DATA_DIR
    ? resolve(process.env.FREETAXUSA_USER_DATA_DIR.replace('~', homedir()))
    : DEFAULT_USER_DATA_DIR;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  return dir;
}

export async function getBrowserContext(): Promise<BrowserContext> {
  if (browserContext) return browserContext;

  const userDataDir = ensureUserDataDir();
  const headless = process.env.FREETAXUSA_HEADLESS !== 'false';

  browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreHTTPSErrors: false,
    bypassCSP: false,
  });

  return browserContext;
}

export async function getPage(): Promise<Page> {
  const ctx = await getBrowserContext();
  if (activePage && !activePage.isClosed()) {
    return activePage;
  }
  const pages = ctx.pages();
  activePage = pages.length > 0 ? pages[0] : await ctx.newPage();
  return activePage;
}

/**
 * Result of attempting to seed the session from Hermes.
 *  - 'seeded'         → cookies obtained from Hermes and injected; skip embedded login.
 *  - 'not_configured' → Hermes env not set; caller should run the embedded login as before.
 *  - 'legacy_fallback'→ Hermes configured-but-down AND FREETAXUSA_LEGACY_AUTH=true; fall back.
 * Throws when Hermes is configured-but-down and legacy auth is NOT enabled (fail loud),
 * or when Hermes returns a non-cookie / malformed bundle.
 */
export type HermesSeedOutcome = 'seeded' | 'not_configured' | 'legacy_fallback';

/**
 * Try to obtain the FreeTaxUSA login session from Hermes and inject it into the
 * persistent browser context. Hermes is the authoritative auth path when
 * configured; this is called before any embedded Playwright login.
 */
export async function seedSessionFromHermes(): Promise<HermesSeedOutcome> {
  const client = HermesClient.fromEnv('freetaxusa');
  if (!client) {
    // Hermes not configured — the embedded Playwright login is legitimate.
    return 'not_configured';
  }

  try {
    const bundle = await client.getCookieBundle();
    const cookies = HermesClient.cookiesFromBundle(bundle, SESSION_COOKIE_DOMAINS);
    if (cookies.length === 0) {
      throw new Error('Hermes returned an empty cookie set for freetaxusa');
    }

    const ctx = await getBrowserContext();
    await ctx.addCookies(cookies);
    process.stderr.write(
      `[freetaxusa-mcp] INFO: seeded session from Hermes (${cookies.length} cookies, expires ${
        bundle.expiresAt ? new Date(bundle.expiresAt).toISOString() : 'unknown'
      })\n`,
    );
    return 'seeded';
  } catch (err) {
    if (err instanceof HermesUnavailableError) {
      if (!isLegacyAuthEnabled()) {
        process.stderr.write(
          `[freetaxusa-mcp] ERROR: Hermes auth failed for freetaxusa and FREETAXUSA_LEGACY_AUTH is not set — refusing to fall back to embedded browser login: ${err.message}\n`,
        );
        throw new Error(
          'Hermes auth failed for freetaxusa — ensure the Hermes broker is running and ' +
            'HERMES_URL/HERMES_CLIENT_TOKEN are set, and that freetaxusa cookie-session ' +
            'credentials are registered with Hermes. ' +
            '(Set FREETAXUSA_LEGACY_AUTH=true to opt into the embedded Playwright login fallback.)',
        );
      }
      process.stderr.write(
        `[freetaxusa-mcp] WARN: Hermes unavailable, falling back to embedded Playwright login (FREETAXUSA_LEGACY_AUTH=true): ${err.message}\n`,
      );
      return 'legacy_fallback';
    }
    // Non-retryable Hermes error (service not registered, non-cookie bundle, empty set)
    // — surface loudly; this is a misconfiguration, not a transient outage.
    throw err;
  }
}

/**
 * Check if the current page indicates an expired session.
 * Returns true if the user needs to re-authenticate.
 */
export async function isSessionExpired(): Promise<boolean> {
  const page = await getPage();
  const url = page.url();
  return url.includes('auth.freetaxusa.com') || url.includes('/login') || url === 'about:blank';
}

/**
 * Extract the current SID from the page URL.
 */
export function extractSidFromUrl(url: string): number | null {
  const match = url.match(/[?&]sid=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Shut down the browser context gracefully.
 */
export async function closeBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close();
    browserContext = null;
    activePage = null;
  }
}
