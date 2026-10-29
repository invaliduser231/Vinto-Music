const MEDIA_FILE_PATTERN = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|mp4|mov|mkv)$/i;

type AttachmentLike = {
  url?: unknown;
  filename?: unknown;
  content_type?: unknown;
  expired?: unknown;
};

function isPlayableAttachment(attachment: AttachmentLike): boolean {
  if (attachment.expired === true) return false;
  const contentType = String(attachment.content_type ?? '').toLowerCase();
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) return true;
  return MEDIA_FILE_PATTERN.test(String(attachment.filename ?? ''));
}

export function collectPlayableAttachmentUrls(message: Record<string, unknown> | null | undefined): string[] {
  const attachments = message?.attachments;
  if (!Array.isArray(attachments)) return [];

  const urls: string[] = [];
  for (const entry of attachments as AttachmentLike[]) {
    if (!entry || !isPlayableAttachment(entry)) continue;
    const url = String(entry.url ?? '').trim();
    if (/^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}
