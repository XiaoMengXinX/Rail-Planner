import {reach} from './http.mjs';

// With RELAY_URL and RELAY_SECRET set, 12306 lookups go through the Cloudflare Worker in worker/.
export const relayed = Boolean(process.env.RELAY_URL);

export async function relay(path, params) {
  const response = await reach('中转服务', `${process.env.RELAY_URL.replace(/\/$/, '')}${path}?${new URLSearchParams(params)}`, {
    headers: {Authorization: `Bearer ${process.env.RELAY_SECRET}`},
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `中转服务请求失败（${response.status}）`);
  return body;
}
