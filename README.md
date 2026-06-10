# FreeTaxUSA MCP Server

An [MCP](https://modelcontextprotocol.io) server that lets AI agents file your taxes through [FreeTaxUSA](https://www.freetaxusa.com) -- the free federal tax filing service.

Instead of paying $120+ for TurboTax's guided interview, this MCP gives any AI assistant (Claude, etc.) the ability to navigate FreeTaxUSA's interface, fill forms, check your refund, and walk you through filing -- conversationally.

**Federal filing is free. State is $15.99. That's it.**

---

## How It Works

This is not an API wrapper. FreeTaxUSA has no public API.

This MCP uses [Playwright](https://playwright.dev) to drive a real Chromium browser session against FreeTaxUSA's web interface. It reads forms via the accessibility tree, fills fields, navigates between sections, and returns structured data to the AI agent -- which then talks to you like a human tax preparer would.

```
You: "Here's my W-2, help me file"
        |
   [Claude / AI Agent]
        |
   [FreeTaxUSA MCP]  <-- this project
        |
   [Playwright + Chromium]
        |
   [freetaxusa.com]
        |
   [IRS e-file]
```

## Features

- **15 tax filing tools** across personal info, income, deductions, review, and filing
- **Session persistence** -- login once, cookies survive between invocations
- **PII protection** -- SSNs, account numbers, and EINs are automatically redacted from all tool outputs
- **Dynamic navigation** -- discovers FreeTaxUSA's section structure at runtime
- **Anti-bot mitigations** -- realistic viewport, disabled automation flags
- **State paywall detection** -- warns before triggering the $15.99 state filing purchase
- **Prior year support** -- configurable tax year for filing back taxes

## Tools

### Session Management

| Tool | Description |
|------|-------------|
| `authenticate` | Log in. With Hermes configured, the session is brokered (no credentials needed). Otherwise pass email/password — used once, never stored. |
| `get_session_status` | Check if session is active, which tax year and section is loaded. |

### Page Interaction

| Tool | Description |
|------|-------------|
| `read_current_page` | Read all form fields and their current values on the active page. |
| `save_and_continue` | Submit the current page and advance to the next. |
| `navigate_section` | Jump to a section by name ("income", "deductions") or SID number. |

### Personal Information

| Tool | Description |
|------|-------------|
| `fill_taxpayer_info` | Fill name, SSN, DOB, occupation, and address. |
| `fill_filing_status` | Set filing status (single, married joint, head of household, etc.). |

### Tax Overview

| Tool | Description |
|------|-------------|
| `get_tax_summary` | Get return overview: refund/owed, AGI, filing status, completed sections. |
| `get_refund_estimate` | Get current federal and state refund or amount owed. |

### Income (Phase 2)

| Tool | Description |
|------|-------------|
| `fill_w2_income` | Enter W-2 wage and withholding data. |
| `fill_1099_income` | Enter 1099 income (INT, DIV, MISC, NEC, R, G, SSA). |

### Deductions, Review & Filing (Phase 3)

| Tool | Description |
|------|-------------|
| `fill_deductions` | Enter standard or itemized deductions. |
| `review_return` | Run error check and get review results before filing. |
| `file_extension` | File Form 4868 for an automatic 6-month extension. |
| `get_form_status` | Get which sections are complete, incomplete, or have errors. |

> Phase 2 and 3 tools are stubbed and will be implemented in upcoming releases.

## Quick Start

### Prerequisites

- Node.js 20+
- A [FreeTaxUSA](https://www.freetaxusa.com) account (free to create)

### Install

```bash
git clone https://github.com/schwarztim/freetaxusa-mcp.git
cd freetaxusa-mcp
npm install
npm run build
```

Playwright will automatically install Chromium during `npm install`.

### Configure

Add to your Claude Code MCP configuration (`~/.claude/user-mcps.json`):

```json
{
  "mcpServers": {
    "freetaxusa": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/freetaxusa-mcp/dist/index.js"]
    }
  }
}
```

Or for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "freetaxusa": {
      "command": "node",
      "args": ["/path/to/freetaxusa-mcp/dist/index.js"]
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_URL` | _(unset)_ | Hermes broker URL. When set with `HERMES_CLIENT_TOKEN`, Hermes is the authoritative auth path — see [Authentication via Hermes](#authentication-via-hermes). |
| `HERMES_CLIENT_TOKEN` | _(unset)_ | Bearer token for the Hermes broker (from `~/.hermes/client.token`). |
| `HERMES_SERVICE` | `freetaxusa` | Service name registered with Hermes. |
| `HERMES_SCHEME` | `cookie-session` | Credential scheme to request from Hermes. |
| `FREETAXUSA_LEGACY_AUTH` | `false` | Opt back into the embedded Playwright login even when Hermes is configured-but-down. Default fails loudly on a broker outage. |
| `FREETAXUSA_HEADLESS` | `true` | Set to `false` to see the browser window |
| `FREETAXUSA_USER_DATA_DIR` | `~/.freetaxusa-mcp/browser-profile/` | Browser profile directory |
| `FREETAXUSA_TAX_YEAR` | `2025` | Tax year to file (change for prior years) |

### Authentication via Hermes

FreeTaxUSA has no API — authentication is a browser login session (cookies). By
default this server drives an embedded Playwright login with the email/password
you pass to the `authenticate` tool.

When the [Hermes](https://github.com/) auth broker is configured, it becomes the
**authoritative auth path**: Hermes performs the login on the host (handling SSO,
MFA, captcha) and hands this server a fresh cookie session, which is injected
into the browser context. In this mode the `authenticate` tool needs **no
email/password** — just call it.

```bash
export HERMES_URL=http://127.0.0.1:9876
export HERMES_CLIENT_TOKEN="$(cat ~/.hermes/client.token)"
# optional overrides:
# export HERMES_SERVICE=freetaxusa
# export HERMES_SCHEME=cookie-session
```

Behavior:

- **Hermes configured + reachable** → cookie session brokered by Hermes; embedded login is skipped.
- **Hermes configured + unreachable** → authentication **fails loudly** (does not silently fall back to the embedded login). Set `FREETAXUSA_LEGACY_AUTH=true` to opt into the embedded fallback and supply email/password.
- **Hermes not configured** → embedded Playwright login as before (email/password required).

> **Operator setup required:** this server becomes Hermes-capable in code, but
> runtime success depends on the operator registering FreeTaxUSA `cookie-session`
> credentials with the Hermes broker. Until that is done, set
> `FREETAXUSA_LEGACY_AUTH=true` (or leave Hermes unconfigured) to use the
> embedded login.

### Use

Once configured, start a conversation with Claude:

```
You: I need to file my taxes. Log me in to FreeTaxUSA.

Claude: I'll authenticate you now. What's your FreeTaxUSA email and password?

You: email is me@example.com, password is hunter2

Claude: [calls authenticate tool] You're logged in for tax year 2025.
        Let's start with your personal information. What's your full name?

You: John Smith, SSN 123-45-6789, born 01/15/1990

Claude: [calls fill_taxpayer_info] Done. Your address?

You: 123 Main St, Anytown PA 19301

Claude: [fills address, calls save_and_continue]
        Personal info is saved. Your current refund estimate is $2,847.
        Let's move to income. Do you have W-2s to enter?
```

## Architecture

```
src/
  index.ts              # Entry point (stdio transport)
  server.ts             # MCP server + tool registration
  browser/
    context.ts          # Persistent browser context + async mutex
    navigation.ts       # SID-based navigation + dynamic discovery
    forms.ts            # Form reading/filling via accessible labels
  tools/
    session.ts          # authenticate, get_session_status
    overview.ts         # get_tax_summary, get_refund_estimate
    personal.ts         # fill_taxpayer_info, fill_filing_status
    income.ts           # fill_w2_income, fill_1099_income
    deductions.ts       # fill_deductions
    review.ts           # review_return
    filing.ts           # file_extension, get_form_status
    page.ts             # read_current_page, save_and_continue, navigate_section
  security/
    pii-filter.ts       # SSN/EIN/account number redaction
  types/
    tax.ts              # TypeScript interfaces
    sections.ts         # SID mapping + section aliases
```

### Key Design Decisions

**Accessibility tree over CSS selectors.** Form elements are targeted by their accessible label (role + name), not by CSS class or ID. This survives UI redesigns that change styling but preserve semantics.

**Dynamic SID discovery.** FreeTaxUSA uses `?sid=N` URL parameters for navigation. SID values can change between tax years. On first page load, the MCP scrapes navigation links to build a live SID map, with a static fallback.

**PII filter on all outputs.** Every string returned by every tool passes through `filterPII()` before reaching the MCP transport. SSNs are masked to `***-**-NNNN`, EINs to `**-***NNNN`, and account numbers to `****NNNN`. This protects against accidental PII exposure in AI conversation logs.

**Single-page mutex.** The browser has one active page. An async mutex serializes all tool calls to prevent race conditions from concurrent invocations.

**Credentials never stored.** Email and password are accepted as tool inputs, used to fill the login form, and discarded. The persistent browser context retains session cookies only. The profile directory is chmod 0700.

## Security

This MCP handles sensitive financial data. The security model:

- **PII redaction**: All tool outputs are filtered. SSNs, EINs, and account numbers are automatically masked.
- **No credential storage**: Login credentials are provided per-call and never written to disk.
- **Restricted browser profile**: The session directory (`~/.freetaxusa-mcp/browser-profile/`) is created with 0700 permissions.
- **State paywall guard**: Navigation that would trigger a $15.99 purchase throws an error instead of proceeding.
- **Session expiry detection**: Every tool checks for redirect to the login page before acting.

## Development

```bash
# Build
npm run build

# Run in development (auto-recompile)
npm run dev

# Run tests
npm test

# Watch tests
npm run test:watch

# Run with visible browser for debugging
FREETAXUSA_HEADLESS=false npm run start
```

## Prior Year Filing

To file back taxes, set the tax year:

```bash
FREETAXUSA_TAX_YEAR=2024 node dist/index.js
```

FreeTaxUSA supports free federal filing for prior years. Note that prior year returns cannot be e-filed -- they must be printed and mailed.

## Roadmap

- [x] Phase 1: Session, navigation, personal info, tax summary
- [ ] Phase 2: W-2 and 1099 income entry
- [ ] Phase 3: Deductions, review, extension filing
- [ ] Phase 4: W-2/1099 PDF import via Claude vision, section walkthroughs
- [ ] Phase 5: Multi-year batch filing for back taxes

## Disclaimer

This project is not affiliated with, endorsed by, or associated with FreeTaxUSA, TaxHawk Inc., or Intuit. FreeTaxUSA is a registered trademark of TaxHawk, Inc. Use of this tool is subject to FreeTaxUSA's [Terms of Use](https://www.freetaxusa.com/terms). This tool automates a web browser -- the same actions a human would perform manually. You are responsible for the accuracy of your tax return.

## License

MIT
