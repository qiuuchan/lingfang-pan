export function absoluteUpdateAssetUrl(assetUrl: string, baseUrl?: string): string {
  if (isAbsoluteUrl(assetUrl)) return assetUrl;
  if (!baseUrl) throw new Error(`Tauri 更新产物 URL 是相对路径但缺少请求 base URL：${assetUrl}`);
  return new URL(assetUrl, normalizedBaseUrl(baseUrl)).toString();
}

export function requestBaseUrl(request: { get(name: string): string | undefined; protocol: string }): string {
  const host = request.get('host');
  if (!host) throw new Error('无法生成更新下载地址：请求缺少 Host header');
  return `${request.protocol}://${host}`;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
