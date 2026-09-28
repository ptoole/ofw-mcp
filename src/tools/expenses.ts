import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import type { AttachmentIO } from './attachments.js';
import { jsonResponse } from './_shared.js';
import { readUpstreamPaging } from './pagination.js';
import { getExpenseUploadOnly, getWriteMode } from '../config.js';
import { parseLenient } from '@chrischall/mcp-utils';

const UploadedExpenseFileSchema = z.looseObject({
  fileId: z.number(),
  fileName: z.string().optional(),
  label: z.string().optional(),
  fileType: z.string().optional(),
  sizeInBytes: z.number().optional(),
  shareClass: z.string().optional(),
});

const PDF_MIME = 'application/pdf';
const MAX_REMOTE_PDF_BYTES = 25 * 1024 * 1024;

async function resolveRemotePdf(urlValue: string, fileNameValue?: string): Promise<{
  blob: Blob;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:') {
    throw new Error('Remote expense receipt URLs must use HTTPS.');
  }
  if (!url.hostname.toLowerCase().endsWith('.oaiusercontent.com')) {
    throw new Error('Remote expense receipt URLs must be signed oaiusercontent.com file URLs.');
  }

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Unable to fetch remote expense receipt: HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_PDF_BYTES) {
    throw new Error(`Expense receipt exceeds ${MAX_REMOTE_PDF_BYTES} bytes.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REMOTE_PDF_BYTES) {
    throw new Error(`Expense receipt exceeds ${MAX_REMOTE_PDF_BYTES} bytes.`);
  }
  if (
    bytes.byteLength < 5 ||
    bytes[0] !== 0x25 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x2d
  ) {
    throw new Error('Remote expense receipt is not a valid PDF file.');
  }

  const fileName = fileNameValue?.trim() || 'receipt.pdf';
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    throw new Error(`Expense receipts must use a .pdf filename; received ${fileName}`);
  }

  return {
    blob: new Blob([bytes], { type: PDF_MIME }),
    fileName,
    mimeType: PDF_MIME,
    sizeBytes: bytes.byteLength,
  };
}

export function registerExpenseTools(
  server: McpServer,
  client: OFWClient,
  attachmentIO?: AttachmentIO,
): void {
  // Expense writes land on the court-visible record — OFW_WRITE_MODE 'all' only.
  const writeMode = getWriteMode();
  const uploadOnly = getExpenseUploadOnly();
  const allowWrites = writeMode === 'all';
  // A PRIVATE My Files upload is not visible to the co-parent until it is
  // attached to a shared object. Keep the same structural write gate as the
  // generic attachment uploader: unavailable only in OFW_WRITE_MODE=none.
  const allowPrivateUploads = writeMode !== 'none' && attachmentIO !== undefined;

  if (!uploadOnly) server.registerTool('ofw_get_expense_totals', {
    description: 'Get OurFamilyWizard expense summary totals (owed/paid)',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/expense/expenses/totals');
    return jsonResponse(data);
  });

  if (!uploadOnly) server.registerTool('ofw_list_expense_categories', {
    description: 'List OurFamilyWizard expense categories, including preset and custom categories with their responsibility split metadata. Read-only.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/expense/categories');
    return jsonResponse(data);
  });

  if (!uploadOnly) server.registerTool('ofw_list_expenses', {
    description: 'List OurFamilyWizard expenses. OFW pages this endpoint with 1-based page/size parameters; its older start/max parameters are ignored and repeatedly return page 1. The response leads with hasMore and nextPage (null when exhausted) before the records. Continue by passing nextPage.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      page: z.number().int().min(1).describe('1-based page number (default 1). To continue, pass the nextPage returned by the previous response.').optional(),
      size: z.number().int().min(1).max(100).describe('Requested page size (default 20). OFW may cap or normalize this value.').optional(),
    }),
  }, async (args) => {
    const page = args.page ?? 1;
    const size = args.size ?? 20;
    const data = await client.request('GET', `/pub/v2/expense/expenses?page=${page}&size=${size}`);
    const { returned, total, last } = readUpstreamPaging(data);

    const body = typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    if (body === null) return jsonResponse(data);

    const metadata = typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : null;
    const upstreamPage = metadata !== null && typeof metadata.currentPage === 'number'
      ? metadata.currentPage
      : metadata !== null && typeof metadata.page === 'number'
        ? metadata.page
        : page;
    const upstreamSize = metadata !== null && typeof metadata.perPage === 'number'
      ? metadata.perPage
      : size;
    const hasMore = last !== null
      ? !last
      : total !== null
        ? upstreamPage * upstreamSize < total
        : returned >= upstreamSize;
    const nextPage = hasMore ? upstreamPage + 1 : null;
    const scope = total !== null ? ` of ${total}` : '';
    const head = {
      hasMore,
      nextPage,
      page: upstreamPage,
      size: upstreamSize,
      returned,
      ...(total !== null ? { total } : {}),
      paginationNote: hasMore
        ? `PARTIAL: this response holds ${returned} record(s) on page ${upstreamPage}${scope}. Re-call ofw_list_expenses with page:${nextPage}. Do not state a total or an absence from this response alone.`
        : `This response reaches the end of the expense list${scope === '' ? '' : ` (${total} record(s) in total)`}.`,
    };

    return jsonResponse({ ...head, ...body, ...head });
  });

  if (allowPrivateUploads) server.registerTool('ofw_upload_expense_pdf', {
    description: 'Upload a PDF to OurFamilyWizard My Files for later attachment to an expense. Accepts either a local path or a signed ChatGPT/oaiusercontent HTTPS URL plus fileName. Exactly one of path or url must be supplied. This tool accepts PDF files only and uploads them using the same SHARED file metadata as the OFW expense form so the returned fileId can be attached to an expense. Expense visibility is controlled separately by ofw_create_expense privateExpense.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: z.object({
      path: z.string().describe('Absolute path to a local PDF file. Tilde (~) is expanded by the configured attachment I/O implementation. Mutually exclusive with url.').optional(),
      url: z.string().describe('Signed HTTPS oaiusercontent.com URL for a PDF supplied by the ChatGPT host. Mutually exclusive with path.').optional(),
      fileName: z.string().describe('Filename to use for a remote URL upload. Must end in .pdf. Defaults to receipt.pdf.').optional(),
      label: z.string().describe('Display label for the file in OFW (default: filename)').optional(),
      description: z.string().describe('Description shown in OFW My Files (default: filename)').optional(),
    }),
  }, async (args) => {
    const io = attachmentIO!;
    if ((args.path ? 1 : 0) + (args.url ? 1 : 0) !== 1) {
      throw new Error('Pass exactly one of path or url to ofw_upload_expense_pdf.');
    }

    const { blob, fileName, mimeType, sizeBytes } = args.url
      ? await resolveRemotePdf(args.url, args.fileName)
      : await io.resolveUpload(args.path!);
    if (!fileName.toLowerCase().endsWith('.pdf') || mimeType !== PDF_MIME) {
      throw new Error(`Expense receipts must be PDF files; received ${fileName} (${mimeType})`);
    }

    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('source', 'expense');
    form.append('description', args.description ?? fileName);
    form.append('label', args.label ?? fileName);
    form.append('fileName', fileName);
    // Match the OFW expense form upload contract. The attachment itself is
    // uploaded as SHARED so it is eligible for fileIds on an expense. Expense
    // visibility is controlled separately by the expense's isPrivate flag.
    form.append('shared', 'true');
    form.append('shareClass', 'SHARED');

    const meta = parseLenient(
      UploadedExpenseFileSchema,
      await client.request('POST', '/pub/v3/myfiles/multipart', form),
      { label: 'ofw-mcp', context: 'POST /pub/v3/myfiles/multipart (ofw_upload_expense_pdf)', mode: 'strict' },
    );

    return jsonResponse({
      fileId: meta.fileId,
      fileName: meta.fileName ?? fileName,
      mimeType: meta.fileType ?? mimeType,
      sizeBytes: meta.sizeInBytes ?? sizeBytes,
      shareClass: meta.shareClass ?? 'SHARED',
      note: 'Pass fileId to ofw_create_expense as receiptFileId. Expense visibility is controlled separately by privateExpense.',
    });
  });

  if (allowWrites) server.registerTool('ofw_update_expense', {
    description: 'Update an existing OurFamilyWizard expense using the current web-app full-resource update contract. Supply the complete current expense fields plus expenseId. Set privateExpense=false to publish a previously private/staged expense to the co-parent. This is a full update, not a partial patch.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: z.object({
      expenseId: z.number().int().positive().describe('Existing OFW expense entity id'),
      title: z.string().trim().min(1).describe('Current expense title/name shown in OFW'),
      amount: z.number().positive().describe('Current full expense amount'),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Current expense date, YYYY-MM-DD'),
      categoryId: z.number().int().positive().describe('Current OFW expense category id'),
      payerId: z.number().int().positive().describe('Current OFW payer/reimbursing parent userId'),
      children: z.array(z.number().int().positive()).min(1).describe('Current OFW child userIds associated with the expense'),
      description: z.string().trim().min(1).describe('Current supporting description/details, when present').optional(),
      privateExpense: z.boolean().describe('true = visible only to you; false = shared with co-parent'),
      receiptFileId: z.number().int().positive().describe('Current single OFW receipt fileId, when present').optional(),
    }),
  }, async (args) => {
    const payload: Record<string, unknown> = {
      title: args.title,
      amount: args.amount,
      purchaseDate: args.purchaseDate,
      categoryId: args.categoryId,
      payerId: args.payerId,
      children: args.children,
      isPrivate: args.privateExpense,
    };

    if (args.description !== undefined) payload.description = args.description;
    if (args.receiptFileId !== undefined) payload.fileIds = [args.receiptFileId];

    const data = await client.request('PUT', `/pub/v2/expense/expenses/${args.expenseId}`, payload);
    return jsonResponse(data);
  });

  if (allowWrites) server.registerTool('ofw_create_expense', {
    description: 'Log a new expense in OurFamilyWizard using the current web-app expense contract. Required fields are title, amount, purchaseDate, categoryId, payerId (the parent who owes), and at least one child user id. Supports one previously-uploaded receipt PDF and private entries. privateExpense=true creates an expense visible only to you; false/default creates the normal shared expense. receiptFileId should come from ofw_upload_expense_pdf.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: z.object({
      title: z.string().trim().min(1).describe('Expense title/name shown in the OFW expense log'),
      amount: z.number().positive().describe('Full expense amount before OFW applies the category split'),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date the expense was incurred, YYYY-MM-DD'),
      categoryId: z.number().int().positive().describe('OFW expense category id (for example General is commonly id 1; use the id from OFW, not the category display name)'),
      payerId: z.number().int().positive().describe('OFW userId of the parent who owes/reimburses this expense'),
      children: z.array(z.number().int().positive()).min(1).describe('One or more OFW child userIds associated with the expense'),
      description: z.string().trim().min(1).describe('Optional supporting description/details for the expense').optional(),
      privateExpense: z.boolean().describe('true = visible only to you; false/default = shared with co-parent').optional(),
      receiptFileId: z.number().int().positive().describe('Single OFW My Files fileId to attach as the receipt, normally returned by ofw_upload_expense_pdf').optional(),
    }),
  }, async (args) => {
    const payload: Record<string, unknown> = {
      title: args.title,
      amount: args.amount,
      purchaseDate: args.purchaseDate,
      categoryId: args.categoryId,
      payerId: args.payerId,
      children: args.children,
    };

    if (args.description !== undefined) payload.description = args.description;

    // OFW's web app sends isPrivate directly.
    if (args.privateExpense !== undefined) payload.isPrivate = args.privateExpense;

    // OFW's web app sends attachments as a fileIds array. Keep the MCP-facing
    // argument singular so callers still attach at most one canonical receipt.
    if (args.receiptFileId !== undefined) payload.fileIds = [args.receiptFileId];

    const data = await client.request('POST', '/pub/v2/expense', payload);
    return jsonResponse(data);
  });
}
