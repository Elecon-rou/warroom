export type DashboardAttachment = {
  name: string;
  mediaType:
    | 'image/png'
    | 'image/jpeg'
    | 'application/json'
    | 'application/yaml'
    | 'text/markdown'
    | 'text/plain';
  data: string;
};
export const maxAttachments = 4;
export const maxDocumentBytes = 256 * 1024;
export const dashboardAttachmentAccept =
  'image/png,image/jpeg,application/json,application/yaml,text/yaml,text/markdown,text/plain,.json,.yaml,.yml,.md,.markdown,.txt';
export const isDashboardDocument = (file: DashboardAttachment) =>
  ['application/json', 'application/yaml', 'text/markdown', 'text/plain'].includes(file.mediaType);

function documentType(file: File): DashboardAttachment['mediaType'] | undefined {
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'json') return 'application/json';
  if (extension === 'yaml' || extension === 'yml') return 'application/yaml';
  if (extension === 'md' || extension === 'markdown') return 'text/markdown';
  if (extension === 'txt') return 'text/plain';
  const type = file.type.toLowerCase().split(';')[0].trim();
  if (type === 'text/yaml' || type === 'application/x-yaml') return 'application/yaml';
  if (['application/json', 'application/yaml', 'text/markdown', 'text/plain'].includes(type))
    return type as DashboardAttachment['mediaType'];
}

export function validateDocumentReference(text: string): void {
  if (new TextEncoder().encode(text).length > maxDocumentBytes)
    throw new Error('Documents must be at most 256 KiB.');
  if (!text.trim()) throw new Error('Empty documents cannot be attached.');
  if (text.includes('\0')) throw new Error('Documents must contain UTF-8 text without null bytes.');
}
export const maxAttachmentBytes = 8 * 1024 * 1024;
export function attachmentBytes(file: DashboardAttachment): number {
  return isDashboardDocument(file)
    ? new TextEncoder().encode(file.data).length
    : Math.floor((file.data.length * 3) / 4) -
        (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0);
}
export function validateJSONReference(text: string): void {
  validateDocumentReference(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file.');
  }
  if (value === null || typeof value !== 'object')
    throw new Error('JSON files must contain an object or array.');
}
export async function readDashboardAttachment(file: File): Promise<DashboardAttachment> {
  if (!file.size) throw new Error('Empty files cannot be attached.');
  if (new TextEncoder().encode(file.name).length > 200)
    throw new Error('Attachment filename is too long.');
  const mediaType = documentType(file);
  if (mediaType) {
    if (file.size > maxDocumentBytes) throw new Error('Documents must be at most 256 KiB.');
    const data = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    validateDocumentReference(data);
    if (mediaType === 'application/json') validateJSONReference(data);
    return { name: file.name, mediaType, data };
  }
  if (!['image/png', 'image/jpeg'].includes(file.type))
    throw new Error('Attach JSON, YAML, Markdown or text documents, or PNG/JPEG screenshots.');
  if (file.size > 4 * 1024 * 1024) throw new Error('Screenshots must be at most 4 MiB.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Unable to read attachment.'));
    reader.readAsDataURL(file);
  });
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Invalid screenshot.'));
    img.src = `data:${file.type};base64,${data}`;
  });
  if (size.width > 8000 || size.height > 8000 || size.width * size.height > 20000000)
    throw new Error('Screenshots may be up to 8000px per side and 20 megapixels.');
  return { name: file.name, mediaType: file.type as 'image/png' | 'image/jpeg', data };
}
