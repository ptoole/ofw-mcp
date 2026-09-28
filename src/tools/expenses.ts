import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import type { AttachmentIO } from './attachments.js';
import { jsonResponse } from './_shared.js';
import { offsetState, readUpstreamPaging, withPaginationFirst } from './pagination.js';
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

  if (!uploadOnly) server.registerTool('ofw_list_expenses', {
    description: 'List OurFamilyWizard expenses. Offset-paged via start/max. The response leads with its paging state — `hasMore` and `nextStart` (null when the list is exhausted) — BEFORE the records, so a truncated or partially-read response still says whether more remain. Never state an expense total or an absence from one page.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      start: z.number().int().min(0).describe('Start offset, 0-based (default 0). To continue a listing, pass the `nextStart` from the previous response.').optional(),
      max: z.number().int().min(1).describe('Max results (default 20)').optional(),
    }),
  }, async (args) => {
    const start = args.start ?? 0;
    const max = args.max ?? 20;
    const data = await client.request('GET', `/pub/v2/expense/expenses?start=${start}&max=${max}`);
    const { returned, total, last } = readUpstreamPaging(data);
    const wrapped = withPaginationFirst({
      state: offsetState({ start, max, returned, total, last, base: 0 }),
      start, max, returned, total,
      hint: `Re-call ofw_list_expenses with start:${start + max}.`,
      payload: data,
    });
    return jsonResponse(wrapped ?? data);
  });

  if (allowPrivateUploads) server.registerTool('ofw_upload_expense_pdf', {
    description: 'Upload a PDF to OurFamilyWizard My Files for later attachment to an expense. Accepts either a local path or a signed ChatGPT/oaiusercontent HTTPS URL plus fileName. Exactly one of path or url must be supplied. This tool accepts PDF files only and always uploads them with shareClass PRIVATE so the file is not independently shared through My Files. The returned fileId can be passed to ofw_create_expense as receiptFileId.',
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
    // Deliberately not caller-configurable. Expense receipts are uploaded
    // privately and become visible only through the expense they are attached to.
    form.append('shareClass', 'PRIVATE');

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
      shareClass: 'PRIVATE',
      note: 'Pass fileId to ofw_create_expense as receiptFileId. The My Files object itself remains PRIVATE.',
    });
  });

  if (allowWrites) server.registerTool('ofw_create_expense', {
    description: 'Log a new expense in OurFamilyWizard. Supports attaching one previously-uploaded receipt PDF and marking the expense private. privateExpense=true creates an expense visible only to you; false/default creates the normal shared expense. receiptFileId should come from ofw_upload_expense_pdf.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: z.object({
      amount: z.number().positive().describe('Expense amount'),
      description: z.string().min(1).describe('Expense description'),
      privateExpense: z.boolean().describe('true = visible only to you; false/default = shared with co-parent').optional(),
      receiptFileId: z.number().int().positive().describe('Single OFW My Files fileId to attach as the receipt, normally returned by ofw_upload_expense_pdf').optional(),
    }),
  }, async (args) => {
    const payload: Record<string, unknown> = {
      amount: args.amount,
      description: args.description,
    };

    // OFW uses publicFlag for visibility on its other record-creation APIs.
    // Keep the MCP-facing name explicit and human-readable.
    if (args.privateExpense !== undefined) payload.publicFlag = !args.privateExpense;

    // Expense supports one receipt. Keep the tool singular so callers cannot
    // accidentally publish multiple evidence files against one expense.
    if (args.receiptFileId !== undefined) payload.receiptFileId = args.receiptFileId;

    const data = await client.request('POST', '/pub/v2/expense/expenses', payload);
    return jsonResponse(data);
  });
}
