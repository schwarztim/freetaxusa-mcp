/**
 * Minimal Hermes client — fetches the FreeTaxUSA login session (cookies) from a
 * local Hermes broker.
 *
 * Hermes is a host-side MCP auth broker that performs the interactive login
 * (browser SSO, MFA, captcha) OUTSIDE this process and exposes a localhost HTTP
 * API that MCP servers call to get a fresh, already-authenticated cookie bundle.
 * For FreeTaxUSA — a consumer site with no API, authenticated purely by a
 * browser login session — Hermes brokers the cookie-session credential so this
 * server never has to drive an embedded Playwright login itself.
 *
 * Configured via environment variables:
 *   HERMES_URL          e.g. http://127.0.0.1:9876
 *   HERMES_CLIENT_TOKEN bearer token from ~/.hermes/client.token
 *   HERMES_SERVICE      service name registered with Hermes (default: "freetaxusa")
 *   HERMES_SCHEME       scheme to request (default: "cookie-session")
 *
 * Inlined here (rather than depending on an @hermes/client package) so the
 * server build has no extra workspace/npm resolution at install time. This
 * mirrors the proven pattern in tufin-mcp/src/hermes-client.ts; the only
 * functional addition is getCookieBundle() / parseCookieHeader(), because
 * FreeTaxUSA needs structured cookies to inject into a Playwright browser
 * context rather than a single HTTP Cookie header string.
 */

/** Lightweight stderr logger — this server has no shared logger module. */
function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`[HermesClient] ${level.toUpperCase()}: ${message}${suffix}\n`);
}

export interface HermesTokenBundle {
  service: string;
  scheme: string;
  /** For a cookie-session scheme this is the "Cookie:" header string (name=value; ...). */
  accessToken: string;
  /** Expected to be "Cookie" for the cookie-session scheme. */
  tokenType: string;
  expiresAt: number;
  acquiredAt: number;
  /**
   * Optional broker-supplied extras. When present, `extra.cookies` may carry
   * structured Playwright-compatible cookies (with domain/path/expiry) which are
   * preferred over parsing the flat header string.
   */
  extra?: Record<string, unknown>;
}

/** A Playwright-compatible cookie. Mirrors playwright's addCookies() input shape. */
export interface HermesCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface HermesClientOptions {
  brokerUrl: string;
  clientToken: string;
  service: string;
  scheme?: string;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export class HermesUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'HermesUnavailableError';
  }
}

export class HermesClient {
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private inflightRequest: Promise<HermesTokenBundle> | null = null;

  constructor(private readonly opts: HermesClientOptions) {
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * Fetch the current auth bundle. Concurrent calls are deduplicated.
   * Throws HermesUnavailableError if the broker is unreachable.
   */
  async getToken(force = false): Promise<HermesTokenBundle> {
    if (!force && this.inflightRequest) {
      return this.inflightRequest;
    }
    this.inflightRequest = this.fetchWithRetry().finally(() => {
      this.inflightRequest = null;
    });
    return this.inflightRequest;
  }

  /**
   * Convenience wrapper: returns the full bundle, validating that it is a
   * cookie-session credential. Throws HermesUnavailableError if the broker is
   * unreachable. Used by the browser context to seed Playwright cookies.
   */
  async getCookieBundle(force = false): Promise<HermesTokenBundle> {
    const bundle = await this.getToken(force);
    if (bundle.tokenType !== 'Cookie') {
      throw new Error(
        `Hermes service "${this.opts.service}" returned tokenType=${bundle.tokenType}, expected "Cookie" (cookie-session scheme)`,
      );
    }
    return bundle;
  }

  /**
   * Returns a non-null client iff HERMES_URL + HERMES_CLIENT_TOKEN are set.
   * Defaults service to `serviceFallback` and scheme to "cookie-session".
   */
  static fromEnv(serviceFallback = 'freetaxusa'): HermesClient | null {
    const brokerUrl = process.env.HERMES_URL;
    const clientToken = process.env.HERMES_CLIENT_TOKEN;
    if (!brokerUrl || !clientToken) return null;
    return new HermesClient({
      brokerUrl,
      clientToken,
      service: process.env.HERMES_SERVICE || serviceFallback,
      scheme: process.env.HERMES_SCHEME || 'cookie-session',
    });
  }

  /**
   * Resolve structured Playwright cookies from a bundle.
   * Prefers broker-supplied structured cookies in `extra.cookies`; otherwise
   * parses the flat "Cookie:" header string and scopes each cookie to the given
   * domains so Playwright can inject them.
   */
  static cookiesFromBundle(bundle: HermesTokenBundle, fallbackDomains: string[]): HermesCookie[] {
    const structured = bundle.extra?.cookies;
    if (Array.isArray(structured) && structured.length > 0) {
      return structured.filter(
        (c): c is HermesCookie =>
          !!c && typeof (c as HermesCookie).name === 'string' && typeof (c as HermesCookie).value === 'string',
      );
    }
    return HermesClient.parseCookieHeader(bundle.accessToken, fallbackDomains);
  }

  /**
   * Parse a flat "name=value; name2=value2" Cookie header into structured
   * Playwright cookies, duplicating each across the supplied domains (since a
   * header string carries no domain/path metadata).
   */
  static parseCookieHeader(header: string, domains: string[]): HermesCookie[] {
    const pairs = header
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    const cookies: HermesCookie[] = [];
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      for (const domain of domains) {
        cookies.push({ name, value, domain, path: '/', secure: true });
      }
    }
    return cookies;
  }

  private async fetchWithRetry(): Promise<HermesTokenBundle> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.fetchOnce();
      } catch (err) {
        lastErr = err;
        if (err instanceof HermesNonRetryableError) {
          throw err;
        }
        if (attempt < this.retries) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
        }
      }
    }
    throw new HermesUnavailableError(
      `Hermes broker at ${this.opts.brokerUrl} unreachable after ${this.retries + 1} attempts`,
      lastErr,
    );
  }

  private async fetchOnce(): Promise<HermesTokenBundle> {
    const scheme = this.opts.scheme ?? 'cookie-session';
    const url = `${this.opts.brokerUrl.replace(/\/$/, '')}/token/${encodeURIComponent(this.opts.service)}/${encodeURIComponent(scheme)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.clientToken}` },
        signal: ac.signal,
      });
      if (!resp.ok) {
        let body: { code?: string; message?: string; remediation?: string } = {};
        try {
          body = (await resp.json()) as typeof body;
        } catch {
          /* non-JSON error body — ignore */
        }
        const msg = `Hermes ${resp.status}: ${body.message ?? resp.statusText}${body.remediation ? ` — ${body.remediation}` : ''}`;
        // 4xx with a code are non-retryable (auth required, service not registered, etc.)
        if (resp.status >= 400 && resp.status < 500) {
          throw new HermesNonRetryableError(msg);
        }
        throw new Error(msg);
      }
      const bundle = (await resp.json()) as HermesTokenBundle;
      if (!bundle?.accessToken || typeof bundle.accessToken !== 'string') {
        throw new HermesNonRetryableError('Hermes returned no accessToken');
      }
      log('debug', 'fetched bundle from Hermes', {
        service: bundle.service,
        scheme: bundle.scheme,
        tokenType: bundle.tokenType,
        expiresAt: bundle.expiresAt ? new Date(bundle.expiresAt).toISOString() : 'unknown',
      });
      return bundle;
    } finally {
      clearTimeout(timer);
    }
  }
}

class HermesNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesNonRetryableError';
  }
}
