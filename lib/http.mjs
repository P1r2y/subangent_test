import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createWindowStore } from './window-store.mjs';
import { buildPolicy, routeTask } from './policy.mjs';

const webRoot = new URL('../web/', import.meta.url);
const apiMethods = new Map([
  ['/api/state', ['GET']], ['/api/window-settings', ['GET', 'POST']], ['/api/usage', ['GET']],
  ['/api/settings', ['POST']], ['/api/preview', ['POST']], ['/api/route', ['POST']]
]);
const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
for (const [file, mime] of [['quota.html', 'text/html'], ['quota.css', 'text/css'], ['quota.js', 'text/javascript'], ['window-settings.js', 'text/javascript']]) files.set('/' + file, [file, mime + '; charset=utf-8']);
function reply(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function authenticated(req, token) {
  const got = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from('Bearer ' + token);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { const e = new Error('需要 JSON 请求。'); e.status = 415; throw e; }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) { const e = new Error('请求内容过大。'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须是 JSON 对象。');
  return value;
}

export async function startPanel(store, { port = 0, usageReader, windowStore = createWindowStore(dirname(store.file)), onWindowSettingsChanged = () => {} } = {}) {
  const token = randomBytes(32).toString('hex');
  const off = () => { try { return store.read().enabled === false; } catch { return false; } };
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (req.headers.host !== new URL(origin).host) return reply(res, 403, { error: '不允许此主机名。' });
      if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: '不允许跨站请求。' });
      const path = new URL(req.url, origin).pathname;
      if (path.startsWith('/api/')) {
        if (!authenticated(req, token)) return reply(res, 401, { error: '面板授权已失效，请通过插件重新打开面板。' });
        const allowed = apiMethods.get(path);
        if (!allowed) return reply(res, 404, { error: '接口不存在。' });
        if (!allowed.includes(req.method)) { res.setHeader('Allow', allowed.join(', ')); return reply(res, 405, { error: '不支持此请求方法。' }); }
        if (req.method === 'GET' && path === '/api/state') return reply(res, 200, store.state());
        if (req.method === 'GET' && path === '/api/window-settings') return reply(res, 200, { settings: windowStore.read() });
        if (req.method === 'GET' && path === '/api/usage') {
          if (off()) return reply(res, 200, { status: 'disabled', windows: [], updatedAt: null, stale: false, message: '插件已停用；未读取额度。' });
          return reply(res, 200, usageReader ? await usageReader.read() : { status: 'unavailable', windows: [], updatedAt: null, stale: false, message: '请通过桌面额度浮窗读取。' });
        }
        const data = await body(req);
        if (path === '/api/window-settings') {
          const result = windowStore.save(data);
          onWindowSettingsChanged(result.settings);
          return reply(res, 200, result);
        }
        if (path === '/api/settings') return reply(res, 200, store.save(data));
        if (off() && (path === '/api/preview' || path === '/api/route')) { const e = new Error('插件已停用；开启后才能预览或路由。'); e.status = 400; throw e; }
        if (path === '/api/preview') return reply(res, 200, { policy: buildPolicy(data) });
        if (path === '/api/route') return reply(res, 200, { decision: routeTask({ ...store.read(), ...data }, data) });
        return reply(res, 404, { error: '接口不存在。' });
      }
      if (req.method !== 'GET') return reply(res, 405, { error: '不支持此请求方法。' });
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (!files.has(path)) return reply(res, 404, { error: '页面不存在。' });
      const [file, mime] = files.get(path);
      let content = await readFile(fileURLToPath(new URL(file, webRoot)));
      if (file === 'quota.html') {
        // Validated numeric value is embedded before first paint, including when API reads fail.
        const alpha = windowStore.read().opacity / 100;
        content = Buffer.from(content.toString('utf8').replace('<html lang="zh-CN">', `<html lang="zh-CN" style="--surface-alpha:${alpha}">`));
      }
      res.writeHead(200, { 'Content-Type': mime }); res.end(content);
    } catch (error) {
      if (!res.headersSent) reply(res, error.status || (error instanceof SyntaxError ? 400 : error.code ? 500 : 400), { error: error.code ? '无法完成请求，请检查插件文件和写入权限。' : error.message });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin, token, url: origin + '/#token=' + token, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}
