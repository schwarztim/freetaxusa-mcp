/**
 * MCP server setup and tool registration.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { authenticateSchema, authenticate, getSessionStatusSchema, getSessionStatus } from './tools/session.js';
import { readCurrentPageSchema, readCurrentPage, saveAndContinueSchema, saveAndContinue, navigateSectionSchema, navigateSection } from './tools/page.js';
import { fillTaxpayerInfoSchema, fillTaxpayerInfo, fillFilingStatusSchema, fillFilingStatus } from './tools/personal.js';
import { getTaxSummarySchema, getTaxSummary, getRefundEstimateSchema, getRefundEstimate } from './tools/overview.js';
import { fillW2IncomeSchema, fillW2Income, fill1099IncomeSchema, fill1099Income } from './tools/income.js';
import { fillDeductionsSchema, fillDeductions } from './tools/deductions.js';
import { reviewReturnSchema, reviewReturn } from './tools/review.js';
import { fileExtensionSchema, fileExtension, getFormStatusSchema, getFormStatus } from './tools/filing.js';
import { filterPII } from './security/pii-filter.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'freetaxusa-mcp',
    version: '1.0.0',
  });

  // Helper to wrap tool handlers with consistent error handling
  function wrapHandler(handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    return async (args: Record<string, unknown>) => {
      try {
        const result = await handler(args);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(filterPII(result), null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(filterPII({
              success: false,
              error: 'internal_error',
              message,
            }), null, 2),
          }],
          isError: true,
        };
      }
    };
  }

  // Phase 1: Session tools
  server.tool(
    'authenticate',
    'Log in to FreeTaxUSA. When Hermes is configured (HERMES_URL/HERMES_CLIENT_TOKEN), the session is brokered by Hermes and no email/password is needed. Otherwise, pass email and password for the embedded browser login (credentials are used once and never stored).',
    authenticateSchema.shape,
    wrapHandler(args => authenticate(authenticateSchema.parse(args))),
  );

  server.tool(
    'get_session_status',
    'Check if the FreeTaxUSA session is active and which tax year/section is loaded.',
    getSessionStatusSchema.shape,
    wrapHandler(() => getSessionStatus()),
  );

  // Phase 1: Page tools
  server.tool(
    'read_current_page',
    'Read all form fields and their values on the current FreeTaxUSA page.',
    readCurrentPageSchema.shape,
    wrapHandler(() => readCurrentPage()),
  );

  server.tool(
    'save_and_continue',
    'Submit the current FreeTaxUSA page and advance to the next page.',
    saveAndContinueSchema.shape,
    wrapHandler(() => saveAndContinue()),
  );

  server.tool(
    'navigate_section',
    'Jump to a specific tax section by name (e.g., "income", "deductions") or SID number.',
    {
      section: z.string().optional().describe('Section name (e.g., "income", "deductions", "personal info")'),
      sid: z.number().optional().describe('Direct SID number to navigate to'),
    },
    wrapHandler(args => navigateSection(args as { section?: string; sid?: number })),
  );

  // Phase 1: Personal info tools
  server.tool(
    'fill_taxpayer_info',
    'Fill the taxpayer personal information section (name, SSN, DOB, address, occupation).',
    fillTaxpayerInfoSchema.shape,
    wrapHandler(args => fillTaxpayerInfo(fillTaxpayerInfoSchema.parse(args))),
  );

  server.tool(
    'fill_filing_status',
    'Set the filing status (single, married_joint, married_separate, head_of_household, qualifying_widow).',
    fillFilingStatusSchema.shape,
    wrapHandler(args => fillFilingStatus(fillFilingStatusSchema.parse(args))),
  );

  // Phase 1: Overview tools
  server.tool(
    'get_tax_summary',
    'Get the tax return overview: refund/owed amount, AGI, filing status, completed sections.',
    getTaxSummarySchema.shape,
    wrapHandler(() => getTaxSummary()),
  );

  server.tool(
    'get_refund_estimate',
    'Get the current calculated federal and state refund or amount owed.',
    getRefundEstimateSchema.shape,
    wrapHandler(() => getRefundEstimate()),
  );

  // Phase 2: Income tools (stubbed)
  server.tool(
    'fill_w2_income',
    '[Phase 2 - Not yet implemented] Enter W-2 wage data.',
    fillW2IncomeSchema.shape,
    wrapHandler(args => fillW2Income(fillW2IncomeSchema.parse(args))),
  );

  server.tool(
    'fill_1099_income',
    '[Phase 2 - Not yet implemented] Enter 1099 income data.',
    fill1099IncomeSchema.shape,
    wrapHandler(args => fill1099Income(fill1099IncomeSchema.parse(args))),
  );

  // Phase 3: Deductions, review, filing (stubbed)
  server.tool(
    'fill_deductions',
    '[Phase 3 - Not yet implemented] Enter deduction information (standard or itemized).',
    fillDeductionsSchema.shape,
    wrapHandler(args => fillDeductions(fillDeductionsSchema.parse(args))),
  );

  server.tool(
    'review_return',
    '[Phase 3 - Not yet implemented] Run error check and get review results before filing.',
    reviewReturnSchema.shape,
    wrapHandler(() => reviewReturn()),
  );

  server.tool(
    'file_extension',
    '[Phase 3 - Not yet implemented] File Form 4868 for an automatic extension.',
    fileExtensionSchema.shape,
    wrapHandler(args => fileExtension(fileExtensionSchema.parse(args))),
  );

  server.tool(
    'get_form_status',
    '[Phase 3 - Not yet implemented] Get which sections are complete, incomplete, or have errors.',
    getFormStatusSchema.shape,
    wrapHandler(() => getFormStatus()),
  );

  return server;
}
