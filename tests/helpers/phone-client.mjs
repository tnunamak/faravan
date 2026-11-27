// A phone's requests to the phone listener: an explicit Host header (to test DNS rebinding) and a self-signed certificate.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function call(origin, path, {method = 'GET', body, cookie, host, originHeader, headers: extra = {}} = {}) {
  const url = new URL(path, origin);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = {...extra, host: host ?? url.host, ...(cookie ? {cookie} : {}), ...(body ? {'content-type': 'application/json'} : {})};
  if (originHeader !== null) headers.origin = originHeader ?? (method === 'POST' ? url.origin : undefined);
  if (headers.origin === undefined) delete headers.origin;
  return new Promise((resolve, reject) => {
    const req = request(url, {method, headers, rejectUnauthorized: false}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, headers: res.headers, json, text});
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
export const cookieOf = response => (Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [])
  .map(item => item.split(';')[0]).filter(item => !item.endsWith('=')).join('; ');
