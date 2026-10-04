export interface EntryConfig {
  publicBaseUrl: string | null;
  localUrls: string[];
  entryMode?: 'lan' | 'fixed' | 'temporary';
  publicStatus?: 'connecting' | 'ready' | 'unavailable';
}

function phoneUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      host === '0.0.0.0' ||
      host === '[::]' ||
      /^127\./.test(host)
    )
      return null;
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function phoneEntryUrls(config: EntryConfig): string[] {
  if (config.entryMode === 'temporary') {
    if (config.publicStatus !== 'ready' || !config.publicBaseUrl) return [];
    const published = phoneUrl(config.publicBaseUrl);
    return published?.startsWith('https://') ? [published] : [];
  }
  const local = config.localUrls.map(phoneUrl).filter((url): url is string => !!url);
  const rank = (url: string) => {
    const host = new URL(url).hostname;
    return host.startsWith('192.168.')
      ? 0
      : host.startsWith('10.')
        ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(host)
          ? 2
          : 3;
  };
  local.sort((a, b) => rank(a) - rank(b));
  const published = config.publicBaseUrl ? phoneUrl(config.publicBaseUrl) : null;
  return [...new Set([...(published ? [published] : []), ...local])];
}

export function isPublicEntry(config: EntryConfig): boolean {
  return (
    config.entryMode === 'temporary' ||
    // A developer can pin PUBLIC_BASE_URL to an HTTP Wi-Fi address as well.
    // Keep its original same-network instructions.
    !!(config.publicBaseUrl && phoneUrl(config.publicBaseUrl)?.startsWith('https://'))
  );
}
