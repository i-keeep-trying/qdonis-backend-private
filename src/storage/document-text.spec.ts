import {
  attachmentDisposition,
  detectDocumentFormat,
  parseDocument,
  sanitizeFilename,
} from './document-text';

describe('document-text', () => {
  it('detects formats by extension and magic bytes', () => {
    expect(detectDocumentFormat('a.PDF', Buffer.from('%PDF-1.4'))).toBe('pdf');
    expect(
      detectDocumentFormat('a.docx', Buffer.from([0x50, 0x4b, 3, 4])),
    ).toBe('docx');
    expect(detectDocumentFormat('a.md', Buffer.from('# hi'))).toBe('text');
    expect(() => detectDocumentFormat('a.pdf', Buffer.from('nope'))).toThrow();
    expect(() => detectDocumentFormat('a.docx', Buffer.from('nope'))).toThrow();
    expect(() => detectDocumentFormat('a.doc', Buffer.from('x'))).toThrow();
    expect(() =>
      detectDocumentFormat('a.txt', Buffer.from([0x61, 0, 0x62])),
    ).toThrow();
  });

  it('extracts text and refuses empty or invalid input', async () => {
    await expect(
      parseDocument('a.txt', Buffer.from('\uFEFF  hello ')),
    ).resolves.toMatchObject({
      text: 'hello',
    });
    await expect(
      parseDocument('a.pdf', Buffer.from('%PDF-1.4 x')),
    ).resolves.toMatchObject({
      text: null,
      contentType: 'application/pdf',
    });
    await expect(parseDocument('a.txt', Buffer.alloc(0))).rejects.toThrow(
      'File is empty',
    );
    await expect(
      parseDocument('a.txt', Buffer.from([0xff, 0xfe, 0x41])),
    ).rejects.toThrow(/UTF-8/);
    await expect(
      parseDocument('a.docx', Buffer.from([0x50, 0x4b, 3, 4, 1, 2])),
    ).rejects.toThrow(/could not be read/);
  });

  it('sanitises names and builds safe dispositions', () => {
    expect(sanitizeFilename('../../etc/pass\u0000wd')).toBe('passwd');
    expect(sanitizeFilename('')).toBe('file');
    expect(attachmentDisposition('Spéc "v1".pdf')).toBe(
      `attachment; filename="Sp_c _v1_.pdf"; filename*=UTF-8''Sp%C3%A9c%20%22v1%22.pdf`,
    );
  });
});
