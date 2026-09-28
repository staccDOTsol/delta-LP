const retryKeys = new Map<string, string>();
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const signature = path + JSON.stringify(body);
  const isWrite = body !== undefined && !['/api/simulate', '/api/vault/value'].includes(path);
  const key = isWrite ? retryKeys.get(signature) ?? crypto.randomUUID() : '';
  if (isWrite) retryKeys.set(signature, key);
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(isWrite ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const result = await response.json();
  if (isWrite && response.status < 500) retryKeys.delete(signature);
  if (!response.ok) throw new Error(result.error ?? 'Request failed. Please retry.');
  return result as T;
}
