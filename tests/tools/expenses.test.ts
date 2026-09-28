import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import type { AttachmentIO } from '../../src/tools/attachments.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let handlers: Map<string, ToolHandler>;

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

function makeAttachmentIO(
  fileName = 'receipt.pdf',
  mimeType = 'application/pdf',
): AttachmentIO {
  return {
    supportsDisk: true,
    resolveUpload: vi.fn().mockResolvedValue({
      blob: new Blob(['%PDF-1.4\n'], { type: mimeType }),
      fileName,
      mimeType,
      sizeBytes: 9,
    }),
    readDownloaded: () => null,
    writeDownload: () => undefined,
  };
}

function setup(client: OFWClient, attachmentIO?: AttachmentIO) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerExpenseTools(server, client, attachmentIO);
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_get_expense_totals', () => {
  it('calls /pub/v2/expense/expenses/totals', async () => {
    const totals = { owed: 100, paid: 50 };
    const client = makeClient(totals);
    setup(client);
    const result = await handlers.get('ofw_get_expense_totals')!({});
    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/expense/expenses/totals');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(totals);
  });
});

describe('ofw_list_expenses', () => {
  it('calls expenses with default pagination', async () => {
    const client = makeClient([]);
    setup(client);
    await handlers.get('ofw_list_expenses')!({});
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=0&max=20'
    );
  });

  it('reports zero returned when the response carries no record array at all', async () => {
    const client = makeClient({ message: 'no records' });
    setup(client);
    const parsed = JSON.parse((await handlers.get('ofw_list_expenses')!({})).content[0].text);
    expect(parsed.returned).toBe(0);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextStart).toBeNull();
    expect(parsed.message).toBe('no records');
  });

  it('passes custom start and max', async () => {
    const client = makeClient([]);
    setup(client);
    await handlers.get('ofw_list_expenses')!({ start: 20, max: 10 });
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v2/expense/expenses?start=20&max=10'
    );
  });
});

describe('ofw_upload_expense_pdf', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('uploads a PDF as a PRIVATE expense-source My Files object', async () => {
    const client = makeClient({
      fileId: 123,
      fileName: 'receipt.pdf',
      fileType: 'application/pdf',
      sizeInBytes: 9,
      shareClass: 'PRIVATE',
    });
    const io = makeAttachmentIO();
    setup(client, io);

    const result = await handlers.get('ofw_upload_expense_pdf')!({ path: '/tmp/receipt.pdf' });
    expect(io.resolveUpload).toHaveBeenCalledWith('/tmp/receipt.pdf');

    const call = vi.mocked(client.request).mock.calls[0];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/pub/v3/myfiles/multipart');
    const form = call[2] as FormData;
    expect(form.get('source')).toBe('expense');
    expect(form.get('shareClass')).toBe('PRIVATE');
    expect(form.get('fileName')).toBe('receipt.pdf');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.fileId).toBe(123);
    expect(parsed.shareClass).toBe('PRIVATE');
  });

  it('uploads a signed hosted PDF URL without using local AttachmentIO', async () => {
    const client = makeClient({
      fileId: 456,
      fileName: 'receipt.pdf',
      fileType: 'application/pdf',
      sizeInBytes: 9,
      shareClass: 'PRIVATE',
    });
    const io = makeAttachmentIO();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': '9',
        },
      }),
    );

    setup(client, io);
    const result = await handlers.get('ofw_upload_expense_pdf')!({
      url: 'https://example.oaiusercontent.com/files/receipt/raw?sig=test',
      fileName: 'receipt.pdf',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(io.resolveUpload).not.toHaveBeenCalled();

    const call = vi.mocked(client.request).mock.calls[0];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/pub/v3/myfiles/multipart');
    const form = call[2] as FormData;
    expect(form.get('source')).toBe('expense');
    expect(form.get('shareClass')).toBe('PRIVATE');
    expect(form.get('fileName')).toBe('receipt.pdf');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.fileId).toBe(456);
    expect(parsed.shareClass).toBe('PRIVATE');
  });

  it('rejects untrusted remote PDF hosts before calling OFW', async () => {
    const client = makeClient({});
    setup(client, makeAttachmentIO());

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({
        url: 'https://example.com/receipt.pdf',
        fileName: 'receipt.pdf',
      }),
    ).rejects.toThrow(/oaiusercontent\.com/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('requires exactly one upload source', async () => {
    const client = makeClient({});
    setup(client, makeAttachmentIO());

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({ fileName: 'receipt.pdf' }),
    ).rejects.toThrow(/exactly one of path or url/i);

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({
        path: '/tmp/receipt.pdf',
        url: 'https://example.oaiusercontent.com/files/receipt/raw?sig=test',
        fileName: 'receipt.pdf',
      }),
    ).rejects.toThrow(/exactly one of path or url/i);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects non-PDF uploads before calling OFW', async () => {
    const client = makeClient({});
    setup(client, makeAttachmentIO('receipt.jpg', 'image/jpeg'));

    await expect(
      handlers.get('ofw_upload_expense_pdf')!({ path: '/tmp/receipt.jpg' }),
    ).rejects.toThrow(/must be PDF/i);
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('ofw_create_expense', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
    process.env.OFW_WRITE_MODE = 'all';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('posts the legacy amount/description shape when optional fields are omitted', async () => {
    const client = makeClient({ id: 99 });
    setup(client, makeAttachmentIO());
    const result = await handlers.get('ofw_create_expense')!({ amount: 50, description: 'School supplies' });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense/expenses',
      { amount: 50, description: 'School supplies' },
    );
    expect(result.content).toHaveLength(1);
  });

  it('maps privateExpense to publicFlag=false and attaches one receipt file', async () => {
    const client = makeClient({ id: 100 });
    setup(client, makeAttachmentIO());
    await handlers.get('ofw_create_expense')!({
      amount: 42.25,
      description: 'Medical copay',
      privateExpense: true,
      receiptFileId: 777,
    });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense/expenses',
      {
        amount: 42.25,
        description: 'Medical copay',
        publicFlag: false,
        receiptFileId: 777,
      },
    );
  });

  it('maps an explicitly shared expense to publicFlag=true', async () => {
    const client = makeClient({ id: 101 });
    setup(client, makeAttachmentIO());
    await handlers.get('ofw_create_expense')!({
      amount: 10,
      description: 'Shared',
      privateExpense: false,
    });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v2/expense/expenses',
      { amount: 10, description: 'Shared', publicFlag: true },
    );
  });
});

describe('expense input schemas', () => {
  it('rejects negative start and non-positive/fractional max', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { inputSchema?: z.ZodObject }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown, _cb: unknown) => {
      configs.set(name, config as { inputSchema?: z.ZodObject });
      return undefined as never;
    });
    registerExpenseTools(server, new OFWClient(), makeAttachmentIO());

    const schema = configs.get('ofw_list_expenses')!.inputSchema!;
    expect(schema.safeParse({ start: -1 }).success).toBe(false);
    expect(schema.safeParse({ max: 0 }).success).toBe(false);
    expect(schema.safeParse({ max: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ start: 0, max: 20 }).success).toBe(true);
  });
});

describe('OFW_WRITE_MODE gating', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.OFW_WRITE_MODE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = original;
  });

  it('expense creation is absent below mode "all"', () => {
    for (const mode of ['none', 'drafts']) {
      process.env.OFW_WRITE_MODE = mode;
      setup(makeClient({}), makeAttachmentIO());
      expect(handlers.has('ofw_create_expense')).toBe(false);
      expect(handlers.has('ofw_list_expenses')).toBe(true);
      expect(handlers.has('ofw_get_expense_totals')).toBe(true);
    }
  });

  it('private PDF upload is available in drafts mode but absent in none', () => {
    process.env.OFW_WRITE_MODE = 'none';
    setup(makeClient({}), makeAttachmentIO());
    expect(handlers.has('ofw_upload_expense_pdf')).toBe(false);

    process.env.OFW_WRITE_MODE = 'drafts';
    setup(makeClient({}), makeAttachmentIO());
    expect(handlers.has('ofw_upload_expense_pdf')).toBe(true);
  });

  it('registers both expense write tools in mode "all"', () => {
    process.env.OFW_WRITE_MODE = 'all';
    setup(makeClient({}), makeAttachmentIO());
    expect(handlers.has('ofw_create_expense')).toBe(true);
    expect(handlers.has('ofw_upload_expense_pdf')).toBe(true);
  });
});


describe('OFW_EXPENSE_UPLOAD_ONLY gating', () => {
  let originalMode: string | undefined;
  let originalOnly: string | undefined;
  let originalUploadOnly: string | undefined;

  beforeEach(() => {
    originalMode = process.env.OFW_WRITE_MODE;
    originalOnly = process.env.OFW_EXPENSE_ONLY;
    originalUploadOnly = process.env.OFW_EXPENSE_UPLOAD_ONLY;
    process.env.OFW_WRITE_MODE = 'all';
    delete process.env.OFW_EXPENSE_ONLY;
    process.env.OFW_EXPENSE_UPLOAD_ONLY = 'true';
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = originalMode;
    if (originalOnly === undefined) delete process.env.OFW_EXPENSE_ONLY;
    else process.env.OFW_EXPENSE_ONLY = originalOnly;
    if (originalUploadOnly === undefined) delete process.env.OFW_EXPENSE_UPLOAD_ONLY;
    else process.env.OFW_EXPENSE_UPLOAD_ONLY = originalUploadOnly;
  });

  it('registers only the upload/create expense tools inside the expense registrar', () => {
    setup(makeClient({}), makeAttachmentIO());
    expect([...handlers.keys()].sort()).toEqual([
      'ofw_create_expense',
      'ofw_upload_expense_pdf',
    ]);
  });
});

