import crypto from 'node:crypto';

/**
 * Minimal S3-compatible R2 client over fetch with AWS SigV4.
 * Reads creds from env (GH Actions secrets):
 *  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_KEY_PREFIX
 *  CLOUDFLARER2TOKEN supported as "accountId:keyId:secret" or "keyId:secret" or raw secret
 *  (with R2_ACCOUNT_ID also set) for seamless setup.
 */
export interface R2Config {
  accountId: string; keyId: string; secret: string; bucket: string; prefix: string; endpoint: string;
}

export function getR2Config(): R2Config | null {
  let accountId = process.env.R2_ACCOUNT_ID || '';
  let keyId = process.env.R2_ACCESS_KEY_ID || '';
  let secret = process.env.R2_SECRET_ACCESS_KEY || '';
  const raw = process.env.CLOUDFLARER2TOKEN || '';
  if ((!keyId || !secret || !accountId) && raw) {
    const parts: string[] = raw.trim().split(':');
    if (parts.length >= 3) { accountId = accountId || (parts[0] as string); keyId = keyId || (parts[1] as string); secret = secret || parts.slice(2).join(':'); }
    else if (parts.length === 2) { keyId = keyId || (parts[0] as string); secret = secret || (parts[1] as string); }
    else { secret = secret || raw.trim(); }
  }
  const bucket = process.env.R2_BUCKET || 'excalidrop';
  const prefix = process.env.R2_KEY_PREFIX || 'scenes/';
  if (!accountId || !keyId || !secret) return null;
  return { accountId, keyId, secret, bucket, prefix, endpoint: `https://${accountId}.r2.cloudflarestorage.com` };
}

async function sha256Hex(data: string | Buffer): Promise<string> {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sign(method: string, urlStr: string, keyId: string, secret: string, region = 'auto', payloadHash?: string, contentType?: string): { Authorization: string; 'x-amz-date': string; 'x-amz-content-sha256': string } {
  const url = new URL(urlStr);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const hash = payloadHash ?? '';
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const canonical = [method, url.pathname + (url.search ? '' : ''), url.searchParams.toString(), canonicalHeaders, signedHeaders, hash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSign = hmac(kService, 'aws4_request');
  const sig = hmac(kSign, toSign).toString('hex');
  return { Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`, 'x-amz-date': amzDate, 'x-amz-content-sha256': hash };
}

export async function r2Get(cfg: R2Config, key: string): Promise<any | null> {
  const url = `${cfg.endpoint}/${cfg.bucket}/${cfg.prefix}${key}`;
  const empty = await sha256Hex('');
  const s = sign('GET', url, cfg.keyId, cfg.secret, 'auto', empty);
  const r = await fetch(url, { headers: { Authorization: s.Authorization, 'x-amz-date': s['x-amz-date'], 'x-amz-content-sha256': empty } });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`R2 GET ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function r2Put(cfg: R2Config, key: string, body: any): Promise<void> {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const url = `${cfg.endpoint}/${cfg.bucket}/${cfg.prefix}${key}`;
  const hash = await sha256Hex(data);
  const s = sign('PUT', url, cfg.keyId, cfg.secret, 'auto', hash, 'application/json');
  const r = await fetch(url, { method: 'PUT', body: data, headers: { Authorization: s.Authorization, 'x-amz-date': s['x-amz-date'], 'x-amz-content-sha256': hash, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`R2 PUT ${r.status}: ${await r.text()}`);
}
