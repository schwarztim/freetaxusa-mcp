/**
 * Session tools: authenticate, get_session_status
 */

import { z } from 'zod';
import { getPage, isSessionExpired, extractSidFromUrl, AUTH_URL, BASE_URL, acquirePageLock, seedSessionFromHermes } from '../browser/context.js';
import { discoverSidMap, waitForPageReady } from '../browser/navigation.js';
import { filterPII } from '../security/pii-filter.js';
import type { SessionStatus } from '../types/tax.js';
import { getPageTitle } from '../browser/forms.js';

export const authenticateSchema = z.object({
  email: z.string().email().optional().describe('FreeTaxUSA account email (not required when Hermes brokers the login)'),
  password: z.string().min(1).optional().describe('FreeTaxUSA account password (not required when Hermes brokers the login)'),
  mfaCode: z.string().optional().describe('MFA code if prompted'),
});

export async function authenticate(input: z.infer<typeof authenticateSchema>): Promise<Record<string, unknown>> {
  const release = await acquirePageLock();
  try {
    const page = await getPage();

    // Hermes is the AUTHORITATIVE auth path when configured. Try it before any
    // embedded Playwright login. If it seeds a session, verify it landed and
    // return — no email/password needed. If Hermes is not configured (or is
    // configured-but-down with FREETAXUSA_LEGACY_AUTH=true), fall through to the
    // embedded login below. If configured-but-down without the legacy flag,
    // seedSessionFromHermes() throws (fail loud).
    const hermesOutcome = await seedSessionFromHermes();
    if (hermesOutcome === 'seeded') {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => {});
      await waitForPageReady(page);
      const landedUrl = page.url();
      const hermesAuthenticated = landedUrl.includes('freetaxusa.com') && !landedUrl.includes('auth.freetaxusa.com');
      const taxYearHermes = process.env.FREETAXUSA_TAX_YEAR ?? '2025';

      if (hermesAuthenticated) {
        await discoverSidMap(page);
        return filterPII({
          authenticated: true,
          authSource: 'hermes',
          taxYear: taxYearHermes,
          currentUrl: landedUrl,
          message: 'Authenticated via Hermes-brokered session.',
        });
      }

      // Cookies were injected but the site still bounced us to login — the
      // brokered session is stale/invalid. Do NOT silently retry with embedded
      // login: that defeats Hermes ownership. Surface it so the operator
      // refreshes the Hermes-side credential.
      return filterPII({
        authenticated: false,
        authSource: 'hermes',
        taxYear: taxYearHermes,
        currentUrl: landedUrl,
        message:
          'Hermes provided a session but FreeTaxUSA still requires login (stale/invalid brokered cookies). ' +
          'Refresh the freetaxusa cookie-session credential in Hermes. ' +
          '(Set FREETAXUSA_LEGACY_AUTH=true to allow the embedded Playwright login fallback.)',
      });
    }

    // Embedded Playwright login path: Hermes not configured, or configured-but-down
    // with FREETAXUSA_LEGACY_AUTH=true. Requires email + password.
    if (!input.email || !input.password) {
      return filterPII({
        authenticated: false,
        error: 'credentials_required',
        message:
          'email and password are required for the embedded login. ' +
          'Configure Hermes (HERMES_URL/HERMES_CLIENT_TOKEN) to broker the login instead.',
      });
    }

    await page.goto(AUTH_URL, { waitUntil: 'networkidle', timeout: 20_000 });
    await waitForPageReady(page);

    // Fill login form
    const emailField = page.getByLabel(/email/i).or(page.locator('input[type="email"], input[name*="email"], input[name*="user"]')).first();
    await emailField.fill(input.email);

    const passwordField = page.getByLabel(/password/i).or(page.locator('input[type="password"]')).first();
    await passwordField.fill(input.password);

    // Click sign in
    const signInButton = page.getByRole('button', { name: /sign in|log in|continue/i }).first();
    await signInButton.click();

    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await waitForPageReady(page);

    // Handle MFA if prompted
    const currentUrl = page.url();
    if (currentUrl.includes('mfa') || currentUrl.includes('verify') || currentUrl.includes('2fa')) {
      if (!input.mfaCode) {
        return filterPII({
          authenticated: false,
          mfaRequired: true,
          message: 'MFA code required. Call authenticate again with the mfaCode parameter.',
        });
      }

      const mfaField = page.getByLabel(/code|verification/i).or(page.locator('input[name*="code"], input[name*="mfa"]')).first();
      await mfaField.fill(input.mfaCode);

      const verifyButton = page.getByRole('button', { name: /verify|submit|continue/i }).first();
      await verifyButton.click();

      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await waitForPageReady(page);
    }

    // Check if we landed on the tax app
    const finalUrl = page.url();
    const authenticated = finalUrl.includes('freetaxusa.com') && !finalUrl.includes('auth.freetaxusa.com');

    if (authenticated) {
      // Trigger SID discovery
      await discoverSidMap(page);
    }

    const taxYear = process.env.FREETAXUSA_TAX_YEAR ?? '2025';

    return filterPII({
      authenticated,
      authSource: 'embedded',
      taxYear,
      currentUrl: finalUrl,
      message: authenticated ? 'Successfully authenticated.' : 'Authentication failed. Check credentials.',
    });
  } finally {
    release();
  }
}

export const getSessionStatusSchema = z.object({});

export async function getSessionStatus(): Promise<Record<string, unknown>> {
  const release = await acquirePageLock();
  try {
    const page = await getPage();
    const url = page.url();
    const expired = await isSessionExpired();

    if (expired || url === 'about:blank') {
      return filterPII({
        active: false,
        taxYear: null,
        currentSection: null,
        currentSid: null,
        message: 'No active session. Call authenticate first.',
      } satisfies SessionStatus & { message: string });
    }

    const sid = extractSidFromUrl(url);
    const title = await getPageTitle(page);

    // Try to get section name from SID map
    const sidMap = await discoverSidMap(page);
    const sectionName = sid !== null ? (sidMap.bySid.get(sid) ?? null) : null;

    const taxYear = process.env.FREETAXUSA_TAX_YEAR ?? '2025';

    return filterPII({
      active: true,
      taxYear,
      currentSection: sectionName ?? title,
      currentSid: sid,
    } satisfies SessionStatus);
  } finally {
    release();
  }
}
