// FreeNodePick v1.0.0 — 精选节点订阅（Cloudflare Workers / Pages 通用单文件）
// 只聚合 6 个「为墙内用户维护」的精选节点源 → 格式自动识别 → 跨源去重 → 输出 Clash（带分类分流）/ v2ray 双订阅 + 面板
// 订阅链接形如 /sub/clash-20261104-<密钥>：带日期方便识别；在面板点「生成新链接」后旧链接立即失效
// （需给 Worker/Pages 绑定一个 KV 命名空间，变量名 SUB_KV）；未绑 KV 时自动降级为「链接按天失效」。
// 可选环境变量 GEN_KEY：设置后，生成新链接需输入管理口令（防他人乱点作废你的链接）。
// 部署见 README（Workers 粘贴 / Pages 上传 _worker.js）。
const VERSION = '1.0.0';
const MEM_TTL_MS = 5 * 60 * 1000;      // 内存聚合缓存
const EDGE_TTL = 600;                  // 边缘缓存秒数（订阅与状态接口）
const FETCH_TIMEOUT_MS = 12000;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const MAX_OUT = 88;                    // 每次订阅最多给出的节点数（用户设定）
const MIN_OUT = 36;                    // 每次订阅最少给出的节点数：池子不足时自动用各源备用地址补抓到达标

// 内置源：只收这 6 个精选池（2026-11-04 逐个实拉核验过地址、格式与条数）
// 排列即信任序（轮换选取与补位时靠前者优先）：end-gfw（人工维护、用户家网络实测最稳）→ ermaozi 可达名单（源方自筛）
// → ChromeGo/EdgeGo 官方池 → FreeNodeBiz（持续更新）→ ripaojiedian → 周润发公益
const SOURCES = [
  { id: 'endgfw',       name: 'end-gfw 免费节点（大翻墙运动）', repo: 'hello-world-1989/cn-news',   urls: ['https://raw.githubusercontent.com/hello-world-1989/cn-news/main/end-gfw-free'] },
  { id: 'ermaozi',      name: 'ermaozi 可达节点',               repo: 'ermaozi/get_subscribe',      urls: ['https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/reachable/v2ray.txt', 'https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt'] },
  { id: 'chromego',     name: 'ChromeGo/EdgeGo 节点池',         repo: 'Misaka-blog/chromego_merge', urls: ['https://raw.githubusercontent.com/Misaka-blog/chromego_merge/main/sub/merged_proxies_new.yaml'] },
  { id: 'freenodebiz',  name: 'FreeNodeBiz 精选',                repo: '',                           urls: ['https://freenode.biz/api/featured?format=nsubscribe'], direct: true },
  { id: 'ripaojiedian', name: 'ripaojiedian 永久免费',          repo: 'ripaojiedian/freenode',      urls: ['https://raw.githubusercontent.com/ripaojiedian/freenode/main/sub'] },
  { id: 'shaoyouvip',   name: '周润发公益节点',                  repo: 'shaoyouvip/free',            urls: ['https://raw.githubusercontent.com/shaoyouvip/free/main/mihomo.yaml', 'https://d.zrfme.com/vless-base64'] },
];
// 测活筛选名单：自有流水线（musefnw/fnw-probe，GitHub Actions 每 2 小时用 mihomo 逐个真连接测活）
// 产出的存活名单（按实测延迟升序）。订阅选节点时，池中节点先过这道筛：上榜者按延迟优先入选。
const PROBE_TESTED_URL = 'https://raw.githubusercontent.com/musefnw/fnw-probe/main/tested/tested.txt';

// ---------- 工具 ----------
function b64decodeUtf8(s) {
  s = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function b64urlEncode(str) {
  return b64encodeUtf8(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function stripQuotes(v) {
  v = String(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try { return JSON.parse(v.replace(/^'/, '"').replace(/'$/, '"')); } catch { return v.slice(1, -1); }
  }
  return v;
}
function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}
// 今天日期（北京时间 YYYYMMDD）：订阅链接的日期段与「按天失效」判定都用它
function todayYMD() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return '' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}
function mirrorUrls(rawUrl, order) {
  const m = rawUrl.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return [rawUrl];
  const [, owner, repo, branch, path] = m;
  const variants = {
    raw: rawUrl,
    jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
    gcore: `https://gcore.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
    ghproxy: `https://gh-proxy.com/https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
  };
  return (order || ['raw', 'jsdelivr', 'gcore', 'ghproxy']).map(k => variants[k]).filter(Boolean);
}
function candidateUrls(src) {
  if (src.direct) return src.urls.slice();
  const out = [];
  if (src.dateBase) {
    const now = new Date();
    const dates = [];
    const addDays = (base, n, tzH) => { const d = new Date(base.getTime() + tzH * 3600e3 + n * 86400e3); const s = ymd(d); if (!dates.includes(s)) dates.push(s); };
    addDays(now, 0, 8); addDays(now, 0, 0); addDays(now, -1, 8); addDays(now, -1, 0);
    for (const d of dates) out.push(...mirrorUrls(`${src.dateBase}${d}.yml`, ['raw', 'gcore', 'jsdelivr']));
    return out;
  }
  for (const u of src.urls) out.push(...mirrorUrls(u, src.mirrors));
  return out;
}
async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FreeNodePick/' + VERSION + ')', 'Accept': '*/*' }, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_FETCH_BYTES) throw new Error('文件过大');
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } finally { clearTimeout(timer); }
}

// ---------- 内容嗅探：Clash YAML / 明文链接 / base64 链接 ----------
const LINK_RE = /\b(vmess|vless|trojan|anytls|ssr|ss|hysteria2|hy2|tuic|hysteria|socks5):\/\/[^\s"'<>\[\]{}|]+/gi;
function extractPlainLinks(text) {
  const out = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    let link = m[0].replace(/[),.;]+$/, '');
    out.push(link);
  }
  return out;
}
function sniffLinks(text) {
  const t = String(text || '');
  const looksYaml = /(^|\n)\s*proxies\s*:/.test(t) || ((t.match(/\n\s*-\s*\{?\s*name\s*:/g) || []).length >= 2 && /type\s*:\s*(vless|vmess|trojan|ss|hysteria)/.test(t));
  if (looksYaml) {
    const proxies = parseClashProxies(t);
    const links = [];
    for (const p of proxies) { const l = proxyToLink(p); if (l) links.push(l); }
    if (links.length) return { links, format: 'clash-yaml', rawCount: proxies.length };
  }
  let links = extractPlainLinks(t);
  if (links.length >= 2) return { links, format: 'links', rawCount: links.length };
  // 整体 base64（订阅文件常见形态，可含换行）
  const compact = t.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(compact)) {
    try {
      const dec = b64decodeUtf8(compact);
      links = extractPlainLinks(dec);
      if (links.length) return { links, format: 'base64', rawCount: links.length };
    } catch { /* fallthrough */ }
  }
  return { links: [], format: 'unknown', rawCount: 0 };
}

// ---------- 极简 Clash YAML proxies 解析（block 与 flow 两种写法） ----------
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function parseFlowValue(v) {
  v = String(v).trim();
  if (v.startsWith('{') && v.endsWith('}')) return parseFlowMap(v);
  if (v.startsWith('[') && v.endsWith(']')) return splitTopLevel(v.slice(1, -1), ',').map(x => stripQuotes(x.trim())).filter(x => x !== '');
  return stripQuotes(v);
}
function parseFlowMap(s) {
  const inner = s.trim().replace(/^\{/, '').replace(/\}$/, '');
  const obj = {};
  for (const part of splitTopLevel(inner, ',')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = stripQuotes(part.slice(0, idx).trim());
    obj[key] = parseFlowValue(part.slice(idx + 1));
  }
  return obj;
}
function parseClashProxies(text) {
  const lines = String(text).split(/\r?\n/);
  const proxies = [];
  let inProxies = false, cur = null, nestedKey = null, baseIndent = null;
  const flush = () => { if (cur) proxies.push(cur); cur = null; nestedKey = null; };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!inProxies) {
      if (/^proxies\s*:/.test(line)) inProxies = true;
      continue;
    }
    if (/^[A-Za-z][\w-]*\s*:/.test(line) && !/^\s/.test(line)) { flush(); break; } // 下一个顶层段
    const entryM = line.match(/^(\s*)-\s+(.*)$/);
    if (entryM && (baseIndent === null || entryM[1].length <= baseIndent + 1)) {
      if (baseIndent === null) baseIndent = entryM[1].length;
      flush();
      cur = {};
      const rest = entryM[2].trim();
      if (rest.startsWith('{')) { Object.assign(cur, parseFlowMap(rest)); cur = cur; proxies.push(cur); cur = null; continue; }
      if (rest) { const kv = rest.match(/^([^:]+):\s*(.*)$/); if (kv) cur[stripQuotes(kv[1].trim())] = parseFlowValue(kv[2]); }
      continue;
    }
    if (!cur) continue;
    const kvM = line.match(/^(\s+)([^:\s][^:]*):\s*(.*)$/);
    if (!kvM) continue;
    const indent = kvM[1].length, key = stripQuotes(kvM[2].trim()), val = kvM[3];
    if (nestedKey && indent > (cur.__nestedIndent || 0)) {
      if (typeof cur[nestedKey] === 'object' && cur[nestedKey] !== null) cur[nestedKey][key] = parseFlowValue(val);
      continue;
    }
    nestedKey = null;
    if (val.trim() === '') { cur[key] = {}; nestedKey = key; cur.__nestedIndent = indent; }
    else cur[key] = parseFlowValue(val);
  }
  flush();
  for (const p of proxies) delete p.__nestedIndent;
  return proxies.filter(p => p && p.type && p.server);
}

// ---------- Clash proxy 对象 → 分享链接 ----------
function q(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? '?' + s : '';
}
function proxyToLink(p) {
  const type = String(p.type || '').toLowerCase();
  const server = p.server, port = p.port || 443;
  const name = encodeURIComponent(String(p.name || `${type}-${server}-${port}`));
  const truthy = v => v === true || v === 'true' || v === 1 || v === '1';
  try {
    if (type === 'vless') {
      const ro = p['reality-opts'] || {};
      const ws = p['ws-opts'] || {};
      const grpc = p['grpc-opts'] || {};
      const security = ro['public-key'] ? 'reality' : (truthy(p.tls) ? 'tls' : (p.security || ''));
      return `vless://${p.uuid}@${server}:${port}` + q({
        encryption: 'none', security, sni: p.servername || p.sni || ro['server-name'] || '',
        fp: p['client-fingerprint'] || '', pbk: ro['public-key'] || '', sid: ro['short-id'] || '', spx: ro['spider-x'] || '',
        type: p.network || 'tcp', flow: p.flow || '',
        path: ws.path || '', host: (ws.headers && (ws.headers.Host || ws.headers.host)) || '',
        serviceName: grpc['grpc-service-name'] || '',
      }) + '#' + name;
    }
    if (type === 'vmess') {
      const ws = p['ws-opts'] || {};
      const obj = {
        v: '2', ps: String(p.name || ''), add: String(server), port: String(port), id: String(p.uuid || ''),
        aid: String(p.alterId || 0), scy: String(p.cipher || 'auto'), net: String(p.network || 'tcp'), type: 'none',
        host: (ws.headers && (ws.headers.Host || ws.headers.host)) || '', path: ws.path || '',
        tls: truthy(p.tls) ? 'tls' : '', sni: String(p.servername || p.sni || ''), fp: String(p['client-fingerprint'] || ''),
      };
      if (obj.net === 'grpc') { obj.path = String((p['grpc-opts'] || {})['grpc-service-name'] || ''); }
      return 'vmess://' + b64encodeUtf8(JSON.stringify(obj));
    }
    if (type === 'trojan') {
      const ws = p['ws-opts'] || {};
      return `trojan://${encodeURIComponent(String(p.password || ''))}@${server}:${port}` + q({
        sni: p.sni || p.servername || '', type: p.network || '', path: ws.path || '',
        host: (ws.headers && (ws.headers.Host || ws.headers.host)) || '',
        allowInsecure: truthy(p['skip-cert-verify']) ? '1' : '',
      }) + '#' + name;
    }
    if (type === 'anytls') {
      return `anytls://${encodeURIComponent(String(p.password || ''))}@${server}:${port}` + q({
        sni: p.sni || p.servername || '', allowInsecure: truthy(p['skip-cert-verify']) ? '1' : '',
      }) + '#' + name;
    }
    if (type === 'ss') {
      let plugin = '';
      if (p.plugin) {
        const opts = p['plugin-opts'] || {};
        if (p.plugin === 'obfs') plugin = `obfs-local;obfs=${opts.mode || 'http'};obfs-host=${opts.host || ''}`;
        else if (p.plugin === 'v2ray-plugin') plugin = `v2ray-plugin;mode=${opts.mode || 'websocket'};host=${opts.host || ''};path=${opts.path || ''}${truthy(opts.tls) ? ';tls' : ''}`;
      }
      return `ss://${b64urlEncode(`${p.cipher}:${p.password}`)}@${server}:${port}` + q({ plugin }) + '#' + name;
    }
    if (type === 'hysteria2' || type === 'hy2') {
      return `hysteria2://${encodeURIComponent(String(p.password || p.auth || ''))}@${server}:${port}` + q({
        sni: p.sni || '', insecure: truthy(p['skip-cert-verify']) ? '1' : '',
        obfs: p.obfs || '', 'obfs-password': p['obfs-password'] || '', mport: p.ports || '',
      }) + '#' + name;
    }
    if (type === 'tuic') {
      return `tuic://${p.uuid}:${encodeURIComponent(String(p.password || ''))}@${server}:${port}` + q({
        congestion_control: p['congestion-controller'] || '', alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : (p.alpn || ''),
        sni: p.sni || p.servername || '', udp_relay_mode: p['udp-relay-mode'] || '',
      }) + '#' + name;
    }
    if (type === 'hysteria') {
      return `hysteria://${server}:${port}` + q({
        protocol: p.protocol || 'udp', auth: p.auth || p['auth-str'] || '', peer: p.sni || '',
        insecure: truthy(p['skip-cert-verify']) ? '1' : '', upmbps: p.up || '', downmbps: p.down || '', obfs: p.obfs || '',
      }) + '#' + name;
    }
    if (type === 'socks5') {
      const auth = p.username ? `${encodeURIComponent(String(p.username))}:${encodeURIComponent(String(p.password || ''))}@` : '';
      return `socks5://${auth}${server}:${port}#${name}`;
    }
  } catch { return null; }
  return null;
}

// ---------- 分享链接 → Clash proxy 对象 ----------
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }
function linkToProxy(link) {
  const hashIdx = link.indexOf('#');
  const frag = hashIdx >= 0 ? safeDecode(link.slice(hashIdx + 1)) : '';
  try {
    const type = link.slice(0, link.indexOf('://')).toLowerCase();
    if (type === 'vmess') {
      const j = JSON.parse(b64decodeUtf8(link.slice('vmess://'.length).split('#')[0]));
      const p = {
        name: j.ps || `vmess-${j.add}-${j.port}`, type: 'vmess', server: j.add, port: parseInt(j.port) || 443,
        uuid: j.id, alterId: parseInt(j.aid) || 0, cipher: j.scy || 'auto', udp: true,
      };
      const net = j.net || 'tcp';
      if (net && net !== 'tcp') p.network = net;
      if (j.tls === 'tls' || j.tls === 'reality') { p.tls = true; }
      const sni = j.sni || '';
      if (net === 'ws') { p['ws-opts'] = { path: j.path || '/', headers: j.host ? { Host: j.host } : undefined }; if (sni) p.servername = sni; }
      else if (net === 'grpc') { p['grpc-opts'] = { 'grpc-service-name': j.path || '' }; if (sni) p.servername = sni; }
      else if (sni) p.servername = sni;
      if (j.fp) p['client-fingerprint'] = j.fp;
      if (j.alpn) p.alpn = String(j.alpn).split(',');
      cleanObj(p); cleanObj(p['ws-opts']);
      return p;
    }
    if (type === 'ssr') {
      const dec = b64decodeUtf8(link.slice('ssr://'.length).split('#')[0]);
      const main = dec.split('/?')[0];
      const parts = main.split(':');
      if (parts.length < 6) return null;
      const [server, port, protocol, cipher, obfs, passB64] = parts.slice(-6);
      const params = new URLSearchParams(dec.includes('/?') ? dec.split('/?')[1] : '');
      return cleanObj({
        name: frag || `ssr-${server}-${port}`, type: 'ssr', server, port: parseInt(port) || 443, cipher,
        password: b64decodeUtf8(passB64), protocol, obfs, udp: true,
        'obfs-param': params.get('obfsparam') ? b64decodeUtf8(params.get('obfsparam')) : '',
        'protocol-param': params.get('protoparam') ? b64decodeUtf8(params.get('protoparam')) : '',
      });
    }
    const u = new URL(link);
    const server = u.hostname, port = parseInt(u.port) || 443;
    const sp = u.searchParams;
    const name = frag || `${type}-${server}-${port}`;
    if (type === 'vless') {
      const p = { name, type: 'vless', server, port, uuid: safeDecode(u.username), encryption: 'none', udp: true };
      const net = sp.get('type') || 'tcp';
      if (net !== 'tcp') p.network = net;
      const security = sp.get('security') || '';
      const sni = sp.get('sni') || sp.get('peer') || '';
      if (security === 'tls' || security === 'reality') p.tls = true;
      if (security === 'reality') p['reality-opts'] = cleanObj({ 'public-key': sp.get('pbk') || '', 'short-id': sp.get('sid') || '', 'spider-x': sp.get('spx') || '' });
      if (sni) p.servername = sni;
      if (sp.get('fp')) p['client-fingerprint'] = sp.get('fp');
      if (sp.get('flow')) p.flow = sp.get('flow');
      if (net === 'ws') p['ws-opts'] = cleanObj({ path: sp.get('path') || '/', headers: sp.get('host') ? { Host: sp.get('host') } : undefined });
      if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': sp.get('serviceName') || '' };
      if (sp.get('allowInsecure') === '1' || sp.get('insecure') === '1') p['skip-cert-verify'] = true;
      return cleanObj(p);
    }
    if (type === 'trojan') {
      const p = { name, type: 'trojan', server, port, password: safeDecode(u.username), udp: true };
      const sni = sp.get('sni') || sp.get('peer') || '';
      if (sni) p.sni = sni;
      const net = sp.get('type') || '';
      if (net && net !== 'tcp') { p.network = net; if (net === 'ws') p['ws-opts'] = cleanObj({ path: sp.get('path') || '/', headers: sp.get('host') ? { Host: sp.get('host') } : undefined }); }
      if (sp.get('allowInsecure') === '1' || sp.get('insecure') === '1') p['skip-cert-verify'] = true;
      return cleanObj(p);
    }
    if (type === 'anytls') {
      const p = { name, type: 'anytls', server, port, password: safeDecode(u.username), udp: true };
      const sni = sp.get('sni') || sp.get('peer') || '';
      if (sni) p.sni = sni;
      if (sp.get('allowInsecure') === '1' || sp.get('insecure') === '1') p['skip-cert-verify'] = true;
      return cleanObj(p);
    }
    if (type === 'ss') {
      let userinfo = safeDecode(u.username || '');
      let method = '', password = '';
      if (userinfo.includes(':')) { [method, password] = [userinfo.slice(0, userinfo.indexOf(':')), userinfo.slice(userinfo.indexOf(':') + 1)]; }
      else if (userinfo) { const dec = b64decodeUtf8(userinfo); const i = dec.indexOf(':'); if (i > 0) { method = dec.slice(0, i); password = dec.slice(i + 1); } }
      if (!method) return null;
      const p = { name, type: 'ss', server, port, cipher: method, password, udp: true };
      const pluginStr = sp.get('plugin') || '';
      if (pluginStr) {
        const segs = pluginStr.split(';').map(s => s.trim());
        const kv = {};
        for (const s of segs.slice(1)) { const i = s.indexOf('='); if (i > 0) kv[s.slice(0, i)] = s.slice(i + 1); else kv[s] = true; }
        if (segs[0] === 'obfs-local' || segs[0] === 'obfs') { p.plugin = 'obfs'; p['plugin-opts'] = cleanObj({ mode: kv.obfs || 'http', host: kv['obfs-host'] || '' }); }
        else if (segs[0] === 'v2ray-plugin') { p.plugin = 'v2ray-plugin'; p['plugin-opts'] = cleanObj({ mode: kv.mode || 'websocket', host: kv.host || '', path: kv.path || '', tls: kv.tls !== undefined && kv.tls !== 'false' ? true : '' }); }
      }
      return cleanObj(p);
    }
    if (type === 'hysteria2' || type === 'hy2') {
      const p = { name, type: 'hysteria2', server, port, password: safeDecode(u.username), udp: true };
      if (sp.get('sni')) p.sni = sp.get('sni');
      if (sp.get('insecure') === '1') p['skip-cert-verify'] = true;
      if (sp.get('obfs')) { p.obfs = sp.get('obfs'); if (sp.get('obfs-password')) p['obfs-password'] = sp.get('obfs-password'); }
      if (sp.get('mport')) p.ports = sp.get('mport');
      return cleanObj(p);
    }
    if (type === 'tuic') {
      const p = { name, type: 'tuic', server, port, uuid: safeDecode(u.username), password: safeDecode(u.password || ''), udp: true };
      if (sp.get('congestion_control')) p['congestion-controller'] = sp.get('congestion_control');
      if (sp.get('alpn')) p.alpn = sp.get('alpn').split(',');
      if (sp.get('udp_relay_mode')) p['udp-relay-mode'] = sp.get('udp_relay_mode');
      if (sp.get('allow_insecure') === '1' || sp.get('insecure') === '1') p['skip-cert-verify'] = true;
      return cleanObj(p);
    }
    if (type === 'hysteria') {
      const p = { name, type: 'hysteria', server, port, udp: true };
      if (sp.get('auth')) p.auth = sp.get('auth');
      if (sp.get('peer')) p.sni = sp.get('peer');
      if (sp.get('insecure') === '1') p['skip-cert-verify'] = true;
      if (sp.get('upmbps')) p.up = parseInt(sp.get('upmbps')) || sp.get('upmbps');
      if (sp.get('downmbps')) p.down = parseInt(sp.get('downmbps')) || sp.get('downmbps');
      if (sp.get('obfs')) p.obfs = sp.get('obfs');
      if (sp.get('protocol')) p.protocol = sp.get('protocol');
      return cleanObj(p);
    }
    if (type === 'socks5') {
      const p = { name, type: 'socks5', server, port, udp: true };
      if (u.username) { p.username = safeDecode(u.username); p.password = safeDecode(u.password || ''); }
      return cleanObj(p);
    }
  } catch { return null; }
  return null;
}
function cleanObj(o) {
  if (!o || typeof o !== 'object') return o;
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
    else if (typeof o[k] === 'object' && !Array.isArray(o[k])) { cleanObj(o[k]); if (!Object.keys(o[k]).length) delete o[k]; }
  }
  return o;
}

// ---------- YAML 输出 ----------
function yamlScalar(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map(yamlScalar).join(', ') + ']';
  const s = String(v);
  // 只有绝对安全的字符串才裸输出：字母数字开头、无特殊符号、且不像数字/日期/布尔，避免 @、#、: 等触发 YAML 解析错误
  const safeBare = /^[A-Za-z0-9_][A-Za-z0-9_.\-+/]*$/.test(s)
    && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)
    && !/^0x[0-9a-fA-F]+$/.test(s)
    && !/^\d{4}-\d{2}-\d{2}/.test(s)
    && !/^(true|false|null|yes|no|on|off|~)$/i.test(s);
  return safeBare ? s : JSON.stringify(s);
}
function emitProxyLines(p, indent) {
  const lines = [];
  const pad = ' '.repeat(indent);
  let first = true;
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === '') continue;
    const prefix = first ? pad + '- ' : pad + '  ';
    first = false;
    if (typeof v === 'object' && !Array.isArray(v)) {
      lines.push(prefix + k + ':');
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === undefined || v2 === null || v2 === '') continue;
        if (typeof v2 === 'object' && !Array.isArray(v2)) {
          lines.push(pad + '    ' + k2 + ':');
          for (const [k3, v3] of Object.entries(v2)) if (v3 !== undefined && v3 !== '') lines.push(pad + '      ' + k3 + ': ' + yamlScalar(v3));
        } else lines.push(pad + '    ' + k2 + ': ' + yamlScalar(v2));
      }
    } else lines.push(prefix + k + ': ' + yamlScalar(v));
  }
  return lines;
}
function buildClashYaml(proxies) {
  const names = proxies.map(p => p.name);
  const lines = [
    '# FreeNodePick 精选订阅（Clash / Mihomo）',
    '# 生成时间: ' + new Date().toISOString(),
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'proxies:',
  ];
  for (const p of proxies) lines.push(...emitProxyLines(p, 2));
  // 代理组：ACL4SSR 式分类分流——每个类目一个手动选择组，类目组里都放全部节点，默认指向「🚀 节点选择」
  lines.push('proxy-groups:');
  const emitGroup = (gname, gtype, members, extra) => {
    lines.push('  - name: ' + JSON.stringify(gname));
    lines.push('    type: ' + gtype);
    if (extra) for (const l of extra) lines.push(l);
    lines.push('    proxies:');
    for (const m of members) lines.push('      - ' + JSON.stringify(m));
  };
  emitGroup('⚡ 自动选择', 'url-test', names, ['    url: http://www.gstatic.com/generate_204', '    interval: 300', '    tolerance: 50']);
  emitGroup('🚀 节点选择', 'select', ['⚡ 自动选择', ...names, 'DIRECT']);
  const viaProxy = ['🚀 节点选择', '⚡ 自动选择', ...names, 'DIRECT'];
  const viaDirect = ['DIRECT', '🚀 节点选择', '⚡ 自动选择', ...names];
  emitGroup('🔰 国外流量', 'select', viaProxy);
  emitGroup('⚓ 其他流量', 'select', ['🔰 国外流量', ...viaProxy]);
  emitGroup('🛑 广告拦截', 'select', ['REJECT', 'DIRECT', '🚀 节点选择']);
  emitGroup('✈️ Telegram', 'select', viaProxy);
  emitGroup('📹 Youtube', 'select', viaProxy);
  emitGroup('🎥 Netflix', 'select', viaProxy);
  emitGroup('🎬 DisneyPlus', 'select', viaProxy);
  emitGroup('🌍 国外媒体', 'select', viaProxy);
  emitGroup('📺 巴哈姆特', 'select', viaProxy);
  emitGroup('🌏 国内媒体', 'select', viaDirect);
  emitGroup('🍜 哔哩哔哩', 'select', viaDirect);
  emitGroup('🍎 苹果服务', 'select', viaDirect);
  emitGroup('🎯 全球直连', 'select', viaDirect);
  // 分流规则集：Loyalsoldier/clash-rules（29,126★，通用分类）＋ blackmatrix7/ios_rule_script（28,524★，流媒体分服务清单）
  // 规则集均由客户端经 jsdelivr 镜像拉取、每天自动更新；本站只写引用，不中转规则内容；星数 2026-11-04 GitHub API 直查
  const RP = 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/';
  const providers = [
    ['reject', 'domain'], ['icloud', 'domain'], ['apple', 'domain'], ['google', 'domain'],
    ['proxy', 'domain'], ['direct', 'domain'], ['private', 'domain'], ['gfw', 'domain'],
    ['tld-not-cn', 'domain'], ['telegramcidr', 'ipcidr'], ['cncidr', 'ipcidr'], ['lancidr', 'ipcidr'],
    ['applications', 'classical'],
  ];
  lines.push('rule-providers:');
  for (const [pname, behavior] of providers) {
    lines.push('  ' + pname + ':');
    lines.push('    type: http');
    lines.push('    behavior: ' + behavior);
    lines.push('    url: ' + JSON.stringify(RP + pname + '.txt'));
    lines.push('    path: ./ruleset/' + pname + '.yaml');
    lines.push('    interval: 86400');
  }
  const BM = 'https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master/rule/Clash/';
  const bmProviders = [
    ['youtube', 'YouTube/YouTube'], ['netflix', 'Netflix/Netflix'], ['disney', 'Disney/Disney'],
    ['bahamut', 'Bahamut/Bahamut'], ['bilibili', 'BiliBili/BiliBili'], ['globalmedia', 'GlobalMedia/GlobalMedia'],
    ['chinamedia', 'ChinaMedia/ChinaMedia'],
  ];
  for (const [pname, p] of bmProviders) {
    lines.push('  ' + pname + ':');
    lines.push('    type: http');
    lines.push('    behavior: classical');
    lines.push('    format: text');
    lines.push('    url: ' + JSON.stringify(BM + p + '.list'));
    lines.push('    path: ./ruleset/' + pname + '.list');
    lines.push('    interval: 86400');
  }
  lines.push('rules:');
  lines.push('  - RULE-SET,applications,🎯 全球直连');
  lines.push('  - RULE-SET,private,🎯 全球直连');
  lines.push('  - RULE-SET,reject,🛑 广告拦截');
  lines.push('  - RULE-SET,youtube,📹 Youtube');
  lines.push('  - RULE-SET,netflix,🎥 Netflix');
  lines.push('  - RULE-SET,disney,🎬 DisneyPlus');
  lines.push('  - RULE-SET,bahamut,📺 巴哈姆特');
  lines.push('  - RULE-SET,bilibili,🍜 哔哩哔哩');
  lines.push('  - RULE-SET,globalmedia,🌍 国外媒体');
  lines.push('  - RULE-SET,chinamedia,🌏 国内媒体');
  lines.push('  - RULE-SET,icloud,🍎 苹果服务');
  lines.push('  - RULE-SET,apple,🍎 苹果服务');
  lines.push('  - RULE-SET,google,🔰 国外流量');
  lines.push('  - RULE-SET,telegramcidr,✈️ Telegram');
  lines.push('  - RULE-SET,proxy,🔰 国外流量');
  lines.push('  - RULE-SET,gfw,🔰 国外流量');
  lines.push('  - RULE-SET,tld-not-cn,🔰 国外流量');
  lines.push('  - RULE-SET,direct,🎯 全球直连');
  lines.push('  - RULE-SET,cncidr,🎯 全球直连');
  lines.push('  - RULE-SET,lancidr,🎯 全球直连');
  lines.push('  - GEOIP,LAN,🎯 全球直连,no-resolve');
  lines.push('  - GEOIP,CN,🎯 全球直连,no-resolve');
  lines.push('  - MATCH,⚓ 其他流量');
  return lines.join('\n') + '\n';
}

// ---------- Clash proxy 对象 → sing-box 出站 ----------
function sbTlsFrom(p, sni) {
  const tls = { enabled: true };
  const serverName = sni || p.servername || p.sni || '';
  if (serverName) tls.server_name = serverName;
  if (p['skip-cert-verify']) tls.insecure = true;
  if (p.alpn) tls.alpn = Array.isArray(p.alpn) ? p.alpn : String(p.alpn).split(',');
  const ro = p['reality-opts'];
  if (ro && ro['public-key']) tls.reality = { enabled: true, public_key: String(ro['public-key']), short_id: String(ro['short-id'] || '') };
  const SB_FPS = ['chrome', 'firefox', 'edge', 'safari', 'ios', 'android', '360', 'qq', 'random', 'randomized'];
  if (p['client-fingerprint'] && SB_FPS.includes(String(p['client-fingerprint']).toLowerCase())) tls.utls = { enabled: true, fingerprint: String(p['client-fingerprint']).toLowerCase() };
  else if (tls.reality) tls.utls = { enabled: true, fingerprint: 'chrome' }; // sing-box 规定 Reality 必须带 uTLS，无/野指纹时给默认 chrome
  return tls;
}
function sbTransport(p) {
  const net = p.network || 'tcp';
  const ws = p['ws-opts'] || {};
  if (net === 'ws') {
    const host = ws.headers && (ws.headers.Host || ws.headers.host);
    return cleanObj({ type: 'ws', path: ws.path || '/', headers: host ? { Host: host } : undefined });
  }
  if (net === 'grpc') return { type: 'grpc', service_name: String((p['grpc-opts'] || {})['grpc-service-name'] || '') };
  return undefined;
}
function proxyToSingbox(p) {
  const base = { tag: p.name, server: p.server, server_port: parseInt(p.port) || 443 };
  try {
    switch (String(p.type || '').toLowerCase()) {
      case 'vless': {
        const o = { type: 'vless', ...base, uuid: p.uuid };
        // sing-box 只认 xtls-rprx-vision：udp443 变体归一，其它未知 flow 丢弃以免整份配置被拒
        if (p.flow) { if (String(p.flow).startsWith('xtls-rprx-vision')) o.flow = 'xtls-rprx-vision'; }
        if (p.tls) o.tls = sbTlsFrom(p);
        const t = sbTransport(p); if (t) o.transport = t;
        return cleanObj(o);
      }
      case 'vmess': {
        const o = { type: 'vmess', ...base, uuid: p.uuid, alter_id: parseInt(p.alterId) || 0, security: p.cipher || 'auto' };
        if (p.tls) o.tls = sbTlsFrom(p);
        const t = sbTransport(p); if (t) o.transport = t;
        return cleanObj(o);
      }
      case 'trojan': {
        const o = { type: 'trojan', ...base, password: String(p.password || '') };
        o.tls = sbTlsFrom(p);
        const t = sbTransport(p); if (t) o.transport = t;
        return cleanObj(o);
      }
      case 'ss': {
        const o = { type: 'shadowsocks', ...base, method: p.cipher, password: String(p.password || '') };
        if (p.plugin) {
          const opts = p['plugin-opts'] || {};
          if (p.plugin === 'obfs') { o.plugin = 'obfs-local'; o.plugin_opts = 'obfs=' + (opts.mode || 'http') + (opts.host ? ';obfs-host=' + opts.host : ''); }
          else if (p.plugin === 'v2ray-plugin') { o.plugin = 'v2ray-plugin'; o.plugin_opts = 'mode=' + (opts.mode || 'websocket') + (opts.host ? ';host=' + opts.host : '') + (opts.path ? ';path=' + opts.path : '') + (opts.tls ? ';tls' : ''); }
        }
        return cleanObj(o);
      }
      case 'hysteria2': case 'hy2': {
        const o = { type: 'hysteria2', ...base, password: String(p.password || '') };
        o.tls = sbTlsFrom(p, p.sni);
        if (p.obfs) o.obfs = cleanObj({ type: String(p.obfs), password: String(p['obfs-password'] || '') });
        if (p.ports) {
          const ranges = String(p.ports).split(',').map(s => s.trim()).filter(Boolean).map(s => s.includes('-') ? s.replace('-', ':') : (s.includes(':') ? s : s + ':' + s));
          if (ranges.length) o.server_ports = ranges;
        }
        return cleanObj(o);
      }
      case 'tuic': {
        const o = { type: 'tuic', ...base, uuid: p.uuid, password: String(p.password || '') };
        if (p['congestion-controller']) o.congestion_control = p['congestion-controller'];
        if (p['udp-relay-mode']) o.udp_relay_mode = p['udp-relay-mode'];
        o.tls = sbTlsFrom(p, p.sni || p.servername);
        return cleanObj(o);
      }
      case 'hysteria': {
        const o = { type: 'hysteria', ...base, up_mbps: parseInt(p.up) || 10, down_mbps: parseInt(p.down) || 50 };
        if (p.auth) o.auth_str = String(p.auth);
        if (p.obfs) o.obfs = String(p.obfs);
        o.tls = sbTlsFrom(p, p.sni);
        return cleanObj(o);
      }
      case 'socks5': {
        const o = { type: 'socks', ...base, version: '5' };
        if (p.username) { o.username = String(p.username); o.password = String(p.password || ''); }
        return cleanObj(o);
      }
    }
  } catch { return null; }
  return null; // ssr 等 sing-box 现行版本不支持的协议跳过
}
function buildSingboxConfig(proxies) {
  const outs = [], tags = [];
  for (const p of proxies) { const o = proxyToSingbox(p); if (o) { outs.push(o); tags.push(o.tag); } }
  const cfg = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { type: 'https', tag: 'dns-remote', server: '8.8.8.8', detour: '🚀 节点选择' },
        { type: 'udp', tag: 'dns-local', server: '223.5.5.5', detour: 'direct' },
      ],
      final: 'dns-remote', strategy: 'prefer_ipv4',
    },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], auto_route: true, strict_route: true, stack: 'mixed' },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
    ],
    outbounds: [
      { type: 'selector', tag: '🚀 节点选择', outbounds: ['⚡ 自动选择', ...tags], default: '⚡ 自动选择' },
      { type: 'urltest', tag: '⚡ 自动选择', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '5m', tolerance: 50 },
      ...outs,
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: ['geosite-cn', 'geoip-cn'], outbound: 'direct' },
      ],
      rule_set: [
        { type: 'remote', tag: 'geosite-cn', format: 'binary', url: 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/cn.srs', download_detour: 'direct' },
        { type: 'remote', tag: 'geoip-cn', format: 'binary', url: 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geoip/cn.srs', download_detour: 'direct' },
      ],
      final: '🚀 节点选择', auto_detect_interface: true, default_domain_resolver: 'dns-local',
    },
    experimental: { cache_file: { enabled: true } },
  };
  return { body: JSON.stringify(cfg, null, 2), count: outs.length };
}

// ---------- 去重键 ----------
function nodeKey(link) {
  try {
    const type = link.slice(0, link.indexOf('://')).toLowerCase();
    if (type === 'vmess') {
      const j = JSON.parse(b64decodeUtf8(link.slice(8).split('#')[0]));
      return `vmess|${String(j.add).toLowerCase()}|${j.port}|${j.id}`;
    }
    if (type === 'ssr') return 'ssr|' + link.split('#')[0];
    const u = new URL(link);
    let cred = safeDecode(u.username || '');
    if (type === 'ss' && cred && !cred.includes(':')) { try { cred = b64decodeUtf8(cred); } catch { /* keep */ } }
    if (u.password) cred += ':' + safeDecode(u.password);
    return `${type}|${u.hostname.toLowerCase()}|${u.port}|${cred}`;
  } catch { return link.split('#')[0]; }
}

// ---------- 抓取与聚合 ----------
function buildProxiesFromLinks(links, cap) {
  const nameSet = new Set(), proxies = [];
  for (const link of links) {
    if (proxies.length >= cap) break;
    const p = linkToProxy(link);
    if (!p) continue;
    p.name = String(p.name || (p.type + '-' + p.server + '-' + p.port)).replace(/[\r\n]+/g, ' ').slice(0, 80);
    let n = p.name, k = 2;
    while (nameSet.has(n)) n = p.name + ' #' + (k++);
    p.name = n; nameSet.add(n);
    proxies.push(p);
  }
  return proxies;
}
// 按「基础地址」分组的候选地址：每个源的主地址与备用地址各成一组（组内是同一地址的镜像），供下限补抓逐组尝试
function candidateGroups(src) {
  if (src.direct) return src.urls.map(u => [u]);
  if (src.dateBase) return [candidateUrls(src)];
  return src.urls.map(u => mirrorUrls(u, src.mirrors));
}
async function tryUrlList(urls) {
  let lastErr = '';
  for (const url of urls) {
    try {
      const text = await fetchText(url);
      const { links, format, rawCount } = sniffLinks(text);
      if (links.length) return { ok: true, links, format, rawCount, via: new URL(url).hostname };
      lastErr = '内容无可用节点(' + format + ')';
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  return { ok: false, links: [], format: '', rawCount: 0, error: lastErr };
}
async function fetchSource(src) {
  const started = Date.now();
  const groups = candidateGroups(src);
  let lastErr = '';
  for (let gi = 0; gi < groups.length; gi++) {
    const r = await tryUrlList(groups[gi]);
    if (r.ok) return { ...r, ms: Date.now() - started, usedGroup: gi, groups };
    lastErr = r.error || lastErr;
  }
  return { ok: false, links: [], format: '', rawCount: 0, ms: Date.now() - started, error: lastErr, usedGroup: -1, groups };
}
let _aggCache = null, _aggPromise = null;
async function aggregate() {
  if (_aggCache && Date.now() - _aggCache.ts < MEM_TTL_MS) return _aggCache.data;
  if (_aggPromise) return _aggPromise;
  _aggPromise = (async () => {
    const [results, probeRes] = await Promise.all([
      Promise.all(SOURCES.map(async src => ({ src, res: await fetchSource(src) }))),
      tryUrlList(mirrorUrls(PROBE_TESTED_URL)),
    ]);
    // 测活名单建成「节点键 → 延迟名次」表（名单本身按实测延迟升序），供下方精选筛选
    const probeRank = new Map();
    if (probeRes.ok) probeRes.links.forEach((l, i) => { const k = nodeKey(l); if (!probeRank.has(k)) probeRank.set(k, i); });
    const stats = [], pools = [];
    let totalRaw = 0;
    for (const { src, res } of results) {
      totalRaw += res.links.length;
      pools.push(res.links);
      stats.push({ id: src.id, name: src.name, repo: src.repo, ok: res.ok, fetched: res.links.length, rawCount: res.rawCount || res.links.length, format: res.format || '', ms: res.ms, error: res.ok ? '' : (res.error || '抓取失败') });
    }
    // 跨源轮转交错 + 去重（保证限额截断时各源都有份，并统计每源新增）
    const addedByPool = pools.map(() => 0);
    const poolIdx = pools.map(() => 0);
    let round = true;
    const seenKeys = new Set(); const uniqueLinks = [];
    while (round) {
      round = false;
      pools.forEach((pool, pi) => {
        if (poolIdx[pi] < pool.length) {
          round = true;
          const link = pool[poolIdx[pi]++];
          const key = nodeKey(link);
          if (!seenKeys.has(key)) { seenKeys.add(key); uniqueLinks.push(link); addedByPool[pi]++; }
        }
      });
    }
    stats.forEach((s, i) => { s.added = addedByPool[i]; });
    // 下限保底：去重后不足 MIN_OUT 个时，逐个源尝试它没用过的备用地址组补抓，直到达标或备用耗尽
    let backfilled = 0;
    if (uniqueLinks.length < MIN_OUT) {
      for (let i = 0; i < SOURCES.length && uniqueLinks.length < MIN_OUT; i++) {
        const res = results[i].res;
        if (!res.groups) continue;
        for (let gi = 0; gi < res.groups.length && uniqueLinks.length < MIN_OUT; gi++) {
          if (gi === res.usedGroup) continue;
          const extra = await tryUrlList(res.groups[gi]);
          if (!extra.ok) continue;
          for (const link of extra.links) {
            const key = nodeKey(link);
            if (!seenKeys.has(key)) { seenKeys.add(key); uniqueLinks.push(link); backfilled++; }
          }
        }
      }
    }
    const protocols = {};
    for (const l of uniqueLinks) { const t = l.slice(0, l.indexOf('://')).toLowerCase(); protocols[t] = (protocols[t] || 0) + 1; }
    // 精选筛选（订阅只给筛过的优质节点，两种格式给同一批）：
    // ① 测活筛：同时出现在自有流水线最新存活名单里的节点最优先，按其实测延迟升序；
    // ② 其余节点按来源信任序的轮转顺序补位（池子本身已是精选池）；
    // ③ 名称带推广关键词的条目直接剔除；④ 同一主机最多入选 4 个，防止单个公共服务器扎堆霸榜。
    const screened = [], rest = [];
    for (const l of uniqueLinks) (probeRank.has(nodeKey(l)) ? screened : rest).push(l);
    screened.sort((a, b) => probeRank.get(nodeKey(a)) - probeRank.get(nodeKey(b)));
    const AD_NAME_RE = /官网|订阅地址|购买|充值|机场推荐|电报群|加入频道|t\.me|telegram/i;
    const hostCount = new Map();
    const outLinks = [];
    for (const l of screened.concat(rest)) {
      if (outLinks.length >= MAX_OUT) break;
      let nm = '';
      if (l.startsWith('vmess://')) { try { nm = String(JSON.parse(b64decodeUtf8(l.slice(8).split('#')[0])).ps || ''); } catch { } }
      else if (l.includes('#')) nm = safeDecode(l.slice(l.indexOf('#') + 1));
      if (AD_NAME_RE.test(nm)) continue;
      let host = '';
      try { host = new URL(l).hostname.toLowerCase(); } catch { }
      if (host) { const c = (hostCount.get(host) || 0) + 1; if (c > 4) continue; hostCount.set(host, c); }
      outLinks.push(l);
    }
    const screenedInOut = outLinks.filter(l => probeRank.has(nodeKey(l))).length;
    const v2rayBody = b64encodeUtf8(outLinks.join('\n'));
    const proxies = buildProxiesFromLinks(outLinks, MAX_OUT);
    const data = {
      version: VERSION, updatedAt: new Date().toISOString(),
      totalRaw, totalUnique: uniqueLinks.length, protocols,
      sources: stats, backfilled, minOut: MIN_OUT, maxOut: MAX_OUT,
      probeOk: probeRes.ok, probeAlive: probeRes.ok ? probeRes.links.length : 0,
      screenedCount: screened.length, screenedInOut,
      v2rayCount: outLinks.length, clashCount: proxies.length,
      v2rayBody, clashBody: buildClashYaml(proxies),
    };
    _aggCache = { ts: Date.now(), data };
    _aggPromise = null;
    return data;
  })();
  try { return await _aggPromise; } catch (e) { _aggPromise = null; throw e; }
}

// ---------- 路由 ----------
const QR_LIB = "//---------------------------------------------------------------------\n//\n// QR Code Generator for JavaScript\n//\n// Copyright (c) 2009 Kazuhiko Arase\n//\n// URL: http://www.d-project.com/\n//\n// Licensed under the MIT license:\n//  http://www.opensource.org/licenses/mit-license.php\n//\n// The word 'QR Code' is registered trademark of\n// DENSO WAVE INCORPORATED\n//  http://www.denso-wave.com/qrcode/faqpatent-e.html\n//\n//---------------------------------------------------------------------\n\nvar qrcode = function() {\n\n  //---------------------------------------------------------------------\n  // qrcode\n  //---------------------------------------------------------------------\n\n  /**\n   * qrcode\n   * @param typeNumber 1 to 40\n   * @param errorCorrectionLevel 'L','M','Q','H'\n   */\n  var qrcode = function(typeNumber, errorCorrectionLevel) {\n\n    var PAD0 = 0xEC;\n    var PAD1 = 0x11;\n\n    var _typeNumber = typeNumber;\n    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];\n    var _modules = null;\n    var _moduleCount = 0;\n    var _dataCache = null;\n    var _dataList = [];\n\n    var _this = {};\n\n    var makeImpl = function(test, maskPattern) {\n\n      _moduleCount = _typeNumber * 4 + 17;\n      _modules = function(moduleCount) {\n        var modules = new Array(moduleCount);\n        for (var row = 0; row < moduleCount; row += 1) {\n          modules[row] = new Array(moduleCount);\n          for (var col = 0; col < moduleCount; col += 1) {\n            modules[row][col] = null;\n          }\n        }\n        return modules;\n      }(_moduleCount);\n\n      setupPositionProbePattern(0, 0);\n      setupPositionProbePattern(_moduleCount - 7, 0);\n      setupPositionProbePattern(0, _moduleCount - 7);\n      setupPositionAdjustPattern();\n      setupTimingPattern();\n      setupTypeInfo(test, maskPattern);\n\n      if (_typeNumber >= 7) {\n        setupTypeNumber(test);\n      }\n\n      if (_dataCache == null) {\n        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);\n      }\n\n      mapData(_dataCache, maskPattern);\n    };\n\n    var setupPositionProbePattern = function(row, col) {\n\n      for (var r = -1; r <= 7; r += 1) {\n\n        if (row + r <= -1 || _moduleCount <= row + r) continue;\n\n        for (var c = -1; c <= 7; c += 1) {\n\n          if (col + c <= -1 || _moduleCount <= col + c) continue;\n\n          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )\n              || (0 <= c && c <= 6 && (r == 0 || r == 6) )\n              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {\n            _modules[row + r][col + c] = true;\n          } else {\n            _modules[row + r][col + c] = false;\n          }\n        }\n      }\n    };\n\n    var getBestMaskPattern = function() {\n\n      var minLostPoint = 0;\n      var pattern = 0;\n\n      for (var i = 0; i < 8; i += 1) {\n\n        makeImpl(true, i);\n\n        var lostPoint = QRUtil.getLostPoint(_this);\n\n        if (i == 0 || minLostPoint > lostPoint) {\n          minLostPoint = lostPoint;\n          pattern = i;\n        }\n      }\n\n      return pattern;\n    };\n\n    var setupTimingPattern = function() {\n\n      for (var r = 8; r < _moduleCount - 8; r += 1) {\n        if (_modules[r][6] != null) {\n          continue;\n        }\n        _modules[r][6] = (r % 2 == 0);\n      }\n\n      for (var c = 8; c < _moduleCount - 8; c += 1) {\n        if (_modules[6][c] != null) {\n          continue;\n        }\n        _modules[6][c] = (c % 2 == 0);\n      }\n    };\n\n    var setupPositionAdjustPattern = function() {\n\n      var pos = QRUtil.getPatternPosition(_typeNumber);\n\n      for (var i = 0; i < pos.length; i += 1) {\n\n        for (var j = 0; j < pos.length; j += 1) {\n\n          var row = pos[i];\n          var col = pos[j];\n\n          if (_modules[row][col] != null) {\n            continue;\n          }\n\n          for (var r = -2; r <= 2; r += 1) {\n\n            for (var c = -2; c <= 2; c += 1) {\n\n              if (r == -2 || r == 2 || c == -2 || c == 2\n                  || (r == 0 && c == 0) ) {\n                _modules[row + r][col + c] = true;\n              } else {\n                _modules[row + r][col + c] = false;\n              }\n            }\n          }\n        }\n      }\n    };\n\n    var setupTypeNumber = function(test) {\n\n      var bits = QRUtil.getBCHTypeNumber(_typeNumber);\n\n      for (var i = 0; i < 18; i += 1) {\n        var mod = (!test && ( (bits >> i) & 1) == 1);\n        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;\n      }\n\n      for (var i = 0; i < 18; i += 1) {\n        var mod = (!test && ( (bits >> i) & 1) == 1);\n        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;\n      }\n    };\n\n    var setupTypeInfo = function(test, maskPattern) {\n\n      var data = (_errorCorrectionLevel << 3) | maskPattern;\n      var bits = QRUtil.getBCHTypeInfo(data);\n\n      // vertical\n      for (var i = 0; i < 15; i += 1) {\n\n        var mod = (!test && ( (bits >> i) & 1) == 1);\n\n        if (i < 6) {\n          _modules[i][8] = mod;\n        } else if (i < 8) {\n          _modules[i + 1][8] = mod;\n        } else {\n          _modules[_moduleCount - 15 + i][8] = mod;\n        }\n      }\n\n      // horizontal\n      for (var i = 0; i < 15; i += 1) {\n\n        var mod = (!test && ( (bits >> i) & 1) == 1);\n\n        if (i < 8) {\n          _modules[8][_moduleCount - i - 1] = mod;\n        } else if (i < 9) {\n          _modules[8][15 - i - 1 + 1] = mod;\n        } else {\n          _modules[8][15 - i - 1] = mod;\n        }\n      }\n\n      // fixed module\n      _modules[_moduleCount - 8][8] = (!test);\n    };\n\n    var mapData = function(data, maskPattern) {\n\n      var inc = -1;\n      var row = _moduleCount - 1;\n      var bitIndex = 7;\n      var byteIndex = 0;\n      var maskFunc = QRUtil.getMaskFunction(maskPattern);\n\n      for (var col = _moduleCount - 1; col > 0; col -= 2) {\n\n        if (col == 6) col -= 1;\n\n        while (true) {\n\n          for (var c = 0; c < 2; c += 1) {\n\n            if (_modules[row][col - c] == null) {\n\n              var dark = false;\n\n              if (byteIndex < data.length) {\n                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);\n              }\n\n              var mask = maskFunc(row, col - c);\n\n              if (mask) {\n                dark = !dark;\n              }\n\n              _modules[row][col - c] = dark;\n              bitIndex -= 1;\n\n              if (bitIndex == -1) {\n                byteIndex += 1;\n                bitIndex = 7;\n              }\n            }\n          }\n\n          row += inc;\n\n          if (row < 0 || _moduleCount <= row) {\n            row -= inc;\n            inc = -inc;\n            break;\n          }\n        }\n      }\n    };\n\n    var createBytes = function(buffer, rsBlocks) {\n\n      var offset = 0;\n\n      var maxDcCount = 0;\n      var maxEcCount = 0;\n\n      var dcdata = new Array(rsBlocks.length);\n      var ecdata = new Array(rsBlocks.length);\n\n      for (var r = 0; r < rsBlocks.length; r += 1) {\n\n        var dcCount = rsBlocks[r].dataCount;\n        var ecCount = rsBlocks[r].totalCount - dcCount;\n\n        maxDcCount = Math.max(maxDcCount, dcCount);\n        maxEcCount = Math.max(maxEcCount, ecCount);\n\n        dcdata[r] = new Array(dcCount);\n\n        for (var i = 0; i < dcdata[r].length; i += 1) {\n          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];\n        }\n        offset += dcCount;\n\n        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);\n        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);\n\n        var modPoly = rawPoly.mod(rsPoly);\n        ecdata[r] = new Array(rsPoly.getLength() - 1);\n        for (var i = 0; i < ecdata[r].length; i += 1) {\n          var modIndex = i + modPoly.getLength() - ecdata[r].length;\n          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;\n        }\n      }\n\n      var totalCodeCount = 0;\n      for (var i = 0; i < rsBlocks.length; i += 1) {\n        totalCodeCount += rsBlocks[i].totalCount;\n      }\n\n      var data = new Array(totalCodeCount);\n      var index = 0;\n\n      for (var i = 0; i < maxDcCount; i += 1) {\n        for (var r = 0; r < rsBlocks.length; r += 1) {\n          if (i < dcdata[r].length) {\n            data[index] = dcdata[r][i];\n            index += 1;\n          }\n        }\n      }\n\n      for (var i = 0; i < maxEcCount; i += 1) {\n        for (var r = 0; r < rsBlocks.length; r += 1) {\n          if (i < ecdata[r].length) {\n            data[index] = ecdata[r][i];\n            index += 1;\n          }\n        }\n      }\n\n      return data;\n    };\n\n    var createData = function(typeNumber, errorCorrectionLevel, dataList) {\n\n      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);\n\n      var buffer = qrBitBuffer();\n\n      for (var i = 0; i < dataList.length; i += 1) {\n        var data = dataList[i];\n        buffer.put(data.getMode(), 4);\n        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );\n        data.write(buffer);\n      }\n\n      // calc num max data.\n      var totalDataCount = 0;\n      for (var i = 0; i < rsBlocks.length; i += 1) {\n        totalDataCount += rsBlocks[i].dataCount;\n      }\n\n      if (buffer.getLengthInBits() > totalDataCount * 8) {\n        throw 'code length overflow. ('\n          + buffer.getLengthInBits()\n          + '>'\n          + totalDataCount * 8\n          + ')';\n      }\n\n      // end code\n      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {\n        buffer.put(0, 4);\n      }\n\n      // padding\n      while (buffer.getLengthInBits() % 8 != 0) {\n        buffer.putBit(false);\n      }\n\n      // padding\n      while (true) {\n\n        if (buffer.getLengthInBits() >= totalDataCount * 8) {\n          break;\n        }\n        buffer.put(PAD0, 8);\n\n        if (buffer.getLengthInBits() >= totalDataCount * 8) {\n          break;\n        }\n        buffer.put(PAD1, 8);\n      }\n\n      return createBytes(buffer, rsBlocks);\n    };\n\n    _this.addData = function(data, mode) {\n\n      mode = mode || 'Byte';\n\n      var newData = null;\n\n      switch(mode) {\n      case 'Numeric' :\n        newData = qrNumber(data);\n        break;\n      case 'Alphanumeric' :\n        newData = qrAlphaNum(data);\n        break;\n      case 'Byte' :\n        newData = qr8BitByte(data);\n        break;\n      case 'Kanji' :\n        newData = qrKanji(data);\n        break;\n      default :\n        throw 'mode:' + mode;\n      }\n\n      _dataList.push(newData);\n      _dataCache = null;\n    };\n\n    _this.isDark = function(row, col) {\n      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {\n        throw row + ',' + col;\n      }\n      return _modules[row][col];\n    };\n\n    _this.getModuleCount = function() {\n      return _moduleCount;\n    };\n\n    _this.make = function() {\n      if (_typeNumber < 1) {\n        var typeNumber = 1;\n\n        for (; typeNumber < 40; typeNumber++) {\n          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);\n          var buffer = qrBitBuffer();\n\n          for (var i = 0; i < _dataList.length; i++) {\n            var data = _dataList[i];\n            buffer.put(data.getMode(), 4);\n            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );\n            data.write(buffer);\n          }\n\n          var totalDataCount = 0;\n          for (var i = 0; i < rsBlocks.length; i++) {\n            totalDataCount += rsBlocks[i].dataCount;\n          }\n\n          if (buffer.getLengthInBits() <= totalDataCount * 8) {\n            break;\n          }\n        }\n\n        _typeNumber = typeNumber;\n      }\n\n      makeImpl(false, getBestMaskPattern() );\n    };\n\n    _this.createTableTag = function(cellSize, margin) {\n\n      cellSize = cellSize || 2;\n      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;\n\n      var qrHtml = '';\n\n      qrHtml += '<table style=\"';\n      qrHtml += ' border-width: 0px; border-style: none;';\n      qrHtml += ' border-collapse: collapse;';\n      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';\n      qrHtml += '\">';\n      qrHtml += '<tbody>';\n\n      for (var r = 0; r < _this.getModuleCount(); r += 1) {\n\n        qrHtml += '<tr>';\n\n        for (var c = 0; c < _this.getModuleCount(); c += 1) {\n          qrHtml += '<td style=\"';\n          qrHtml += ' border-width: 0px; border-style: none;';\n          qrHtml += ' border-collapse: collapse;';\n          qrHtml += ' padding: 0px; margin: 0px;';\n          qrHtml += ' width: ' + cellSize + 'px;';\n          qrHtml += ' height: ' + cellSize + 'px;';\n          qrHtml += ' background-color: ';\n          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';\n          qrHtml += ';';\n          qrHtml += '\"/>';\n        }\n\n        qrHtml += '</tr>';\n      }\n\n      qrHtml += '</tbody>';\n      qrHtml += '</table>';\n\n      return qrHtml;\n    };\n\n    _this.createSvgTag = function(cellSize, margin, alt, title) {\n\n      var opts = {};\n      if (typeof arguments[0] == 'object') {\n        // Called by options.\n        opts = arguments[0];\n        // overwrite cellSize and margin.\n        cellSize = opts.cellSize;\n        margin = opts.margin;\n        alt = opts.alt;\n        title = opts.title;\n      }\n\n      cellSize = cellSize || 2;\n      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;\n\n      // Compose alt property surrogate\n      alt = (typeof alt === 'string') ? {text: alt} : alt || {};\n      alt.text = alt.text || null;\n      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;\n\n      // Compose title property surrogate\n      title = (typeof title === 'string') ? {text: title} : title || {};\n      title.text = title.text || null;\n      title.id = (title.text) ? title.id || 'qrcode-title' : null;\n\n      var size = _this.getModuleCount() * cellSize + margin * 2;\n      var c, mc, r, mr, qrSvg='', rect;\n\n      rect = 'l' + cellSize + ',0 0,' + cellSize +\n        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';\n\n      qrSvg += '<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\"';\n      qrSvg += !opts.scalable ? ' width=\"' + size + 'px\" height=\"' + size + 'px\"' : '';\n      qrSvg += ' viewBox=\"0 0 ' + size + ' ' + size + '\" ';\n      qrSvg += ' preserveAspectRatio=\"xMinYMin meet\"';\n      qrSvg += (title.text || alt.text) ? ' role=\"img\" aria-labelledby=\"' +\n          escapeXml([title.id, alt.id].join(' ').trim() ) + '\"' : '';\n      qrSvg += '>';\n      qrSvg += (title.text) ? '<title id=\"' + escapeXml(title.id) + '\">' +\n          escapeXml(title.text) + '</title>' : '';\n      qrSvg += (alt.text) ? '<description id=\"' + escapeXml(alt.id) + '\">' +\n          escapeXml(alt.text) + '</description>' : '';\n      qrSvg += '<rect width=\"100%\" height=\"100%\" fill=\"white\" cx=\"0\" cy=\"0\"/>';\n      qrSvg += '<path d=\"';\n\n      for (r = 0; r < _this.getModuleCount(); r += 1) {\n        mr = r * cellSize + margin;\n        for (c = 0; c < _this.getModuleCount(); c += 1) {\n          if (_this.isDark(r, c) ) {\n            mc = c*cellSize+margin;\n            qrSvg += 'M' + mc + ',' + mr + rect;\n          }\n        }\n      }\n\n      qrSvg += '\" stroke=\"transparent\" fill=\"black\"/>';\n      qrSvg += '</svg>';\n\n      return qrSvg;\n    };\n\n    _this.createDataURL = function(cellSize, margin) {\n\n      cellSize = cellSize || 2;\n      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;\n\n      var size = _this.getModuleCount() * cellSize + margin * 2;\n      var min = margin;\n      var max = size - margin;\n\n      return createDataURL(size, size, function(x, y) {\n        if (min <= x && x < max && min <= y && y < max) {\n          var c = Math.floor( (x - min) / cellSize);\n          var r = Math.floor( (y - min) / cellSize);\n          return _this.isDark(r, c)? 0 : 1;\n        } else {\n          return 1;\n        }\n      } );\n    };\n\n    _this.createImgTag = function(cellSize, margin, alt) {\n\n      cellSize = cellSize || 2;\n      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;\n\n      var size = _this.getModuleCount() * cellSize + margin * 2;\n\n      var img = '';\n      img += '<img';\n      img += '\\u0020src=\"';\n      img += _this.createDataURL(cellSize, margin);\n      img += '\"';\n      img += '\\u0020width=\"';\n      img += size;\n      img += '\"';\n      img += '\\u0020height=\"';\n      img += size;\n      img += '\"';\n      if (alt) {\n        img += '\\u0020alt=\"';\n        img += escapeXml(alt);\n        img += '\"';\n      }\n      img += '/>';\n\n      return img;\n    };\n\n    var escapeXml = function(s) {\n      var escaped = '';\n      for (var i = 0; i < s.length; i += 1) {\n        var c = s.charAt(i);\n        switch(c) {\n        case '<': escaped += '&lt;'; break;\n        case '>': escaped += '&gt;'; break;\n        case '&': escaped += '&amp;'; break;\n        case '\"': escaped += '&quot;'; break;\n        default : escaped += c; break;\n        }\n      }\n      return escaped;\n    };\n\n    var _createHalfASCII = function(margin) {\n      var cellSize = 1;\n      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;\n\n      var size = _this.getModuleCount() * cellSize + margin * 2;\n      var min = margin;\n      var max = size - margin;\n\n      var y, x, r1, r2, p;\n\n      var blocks = {\n        '██': '█',\n        '█ ': '▀',\n        ' █': '▄',\n        '  ': ' '\n      };\n\n      var blocksLastLineNoMargin = {\n        '██': '▀',\n        '█ ': '▀',\n        ' █': ' ',\n        '  ': ' '\n      };\n\n      var ascii = '';\n      for (y = 0; y < size; y += 2) {\n        r1 = Math.floor((y - min) / cellSize);\n        r2 = Math.floor((y + 1 - min) / cellSize);\n        for (x = 0; x < size; x += 1) {\n          p = '█';\n\n          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {\n            p = ' ';\n          }\n\n          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {\n            p += ' ';\n          }\n          else {\n            p += '█';\n          }\n\n          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.\n          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];\n        }\n\n        ascii += '\\n';\n      }\n\n      if (size % 2 && margin > 0) {\n        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');\n      }\n\n      return ascii.substring(0, ascii.length-1);\n    };\n\n    _this.createASCII = function(cellSize, margin) {\n      cellSize = cellSize || 1;\n\n      if (cellSize < 2) {\n        return _createHalfASCII(margin);\n      }\n\n      cellSize -= 1;\n      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;\n\n      var size = _this.getModuleCount() * cellSize + margin * 2;\n      var min = margin;\n      var max = size - margin;\n\n      var y, x, r, p;\n\n      var white = Array(cellSize+1).join('██');\n      var black = Array(cellSize+1).join('  ');\n\n      var ascii = '';\n      var line = '';\n      for (y = 0; y < size; y += 1) {\n        r = Math.floor( (y - min) / cellSize);\n        line = '';\n        for (x = 0; x < size; x += 1) {\n          p = 1;\n\n          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {\n            p = 0;\n          }\n\n          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.\n          line += p ? white : black;\n        }\n\n        for (r = 0; r < cellSize; r += 1) {\n          ascii += line + '\\n';\n        }\n      }\n\n      return ascii.substring(0, ascii.length-1);\n    };\n\n    _this.renderTo2dContext = function(context, cellSize) {\n      cellSize = cellSize || 2;\n      var length = _this.getModuleCount();\n      for (var row = 0; row < length; row++) {\n        for (var col = 0; col < length; col++) {\n          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';\n          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);\n        }\n      }\n    }\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // qrcode.stringToBytes\n  //---------------------------------------------------------------------\n\n  qrcode.stringToBytesFuncs = {\n    'default' : function(s) {\n      var bytes = [];\n      for (var i = 0; i < s.length; i += 1) {\n        var c = s.charCodeAt(i);\n        bytes.push(c & 0xff);\n      }\n      return bytes;\n    }\n  };\n\n  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];\n\n  //---------------------------------------------------------------------\n  // qrcode.createStringToBytes\n  //---------------------------------------------------------------------\n\n  /**\n   * @param unicodeData base64 string of byte array.\n   * [16bit Unicode],[16bit Bytes], ...\n   * @param numChars\n   */\n  qrcode.createStringToBytes = function(unicodeData, numChars) {\n\n    // create conversion map.\n\n    var unicodeMap = function() {\n\n      var bin = base64DecodeInputStream(unicodeData);\n      var read = function() {\n        var b = bin.read();\n        if (b == -1) throw 'eof';\n        return b;\n      };\n\n      var count = 0;\n      var unicodeMap = {};\n      while (true) {\n        var b0 = bin.read();\n        if (b0 == -1) break;\n        var b1 = read();\n        var b2 = read();\n        var b3 = read();\n        var k = String.fromCharCode( (b0 << 8) | b1);\n        var v = (b2 << 8) | b3;\n        unicodeMap[k] = v;\n        count += 1;\n      }\n      if (count != numChars) {\n        throw count + ' != ' + numChars;\n      }\n\n      return unicodeMap;\n    }();\n\n    var unknownChar = '?'.charCodeAt(0);\n\n    return function(s) {\n      var bytes = [];\n      for (var i = 0; i < s.length; i += 1) {\n        var c = s.charCodeAt(i);\n        if (c < 128) {\n          bytes.push(c);\n        } else {\n          var b = unicodeMap[s.charAt(i)];\n          if (typeof b == 'number') {\n            if ( (b & 0xff) == b) {\n              // 1byte\n              bytes.push(b);\n            } else {\n              // 2bytes\n              bytes.push(b >>> 8);\n              bytes.push(b & 0xff);\n            }\n          } else {\n            bytes.push(unknownChar);\n          }\n        }\n      }\n      return bytes;\n    };\n  };\n\n  //---------------------------------------------------------------------\n  // QRMode\n  //---------------------------------------------------------------------\n\n  var QRMode = {\n    MODE_NUMBER :    1 << 0,\n    MODE_ALPHA_NUM : 1 << 1,\n    MODE_8BIT_BYTE : 1 << 2,\n    MODE_KANJI :     1 << 3\n  };\n\n  //---------------------------------------------------------------------\n  // QRErrorCorrectionLevel\n  //---------------------------------------------------------------------\n\n  var QRErrorCorrectionLevel = {\n    L : 1,\n    M : 0,\n    Q : 3,\n    H : 2\n  };\n\n  //---------------------------------------------------------------------\n  // QRMaskPattern\n  //---------------------------------------------------------------------\n\n  var QRMaskPattern = {\n    PATTERN000 : 0,\n    PATTERN001 : 1,\n    PATTERN010 : 2,\n    PATTERN011 : 3,\n    PATTERN100 : 4,\n    PATTERN101 : 5,\n    PATTERN110 : 6,\n    PATTERN111 : 7\n  };\n\n  //---------------------------------------------------------------------\n  // QRUtil\n  //---------------------------------------------------------------------\n\n  var QRUtil = function() {\n\n    var PATTERN_POSITION_TABLE = [\n      [],\n      [6, 18],\n      [6, 22],\n      [6, 26],\n      [6, 30],\n      [6, 34],\n      [6, 22, 38],\n      [6, 24, 42],\n      [6, 26, 46],\n      [6, 28, 50],\n      [6, 30, 54],\n      [6, 32, 58],\n      [6, 34, 62],\n      [6, 26, 46, 66],\n      [6, 26, 48, 70],\n      [6, 26, 50, 74],\n      [6, 30, 54, 78],\n      [6, 30, 56, 82],\n      [6, 30, 58, 86],\n      [6, 34, 62, 90],\n      [6, 28, 50, 72, 94],\n      [6, 26, 50, 74, 98],\n      [6, 30, 54, 78, 102],\n      [6, 28, 54, 80, 106],\n      [6, 32, 58, 84, 110],\n      [6, 30, 58, 86, 114],\n      [6, 34, 62, 90, 118],\n      [6, 26, 50, 74, 98, 122],\n      [6, 30, 54, 78, 102, 126],\n      [6, 26, 52, 78, 104, 130],\n      [6, 30, 56, 82, 108, 134],\n      [6, 34, 60, 86, 112, 138],\n      [6, 30, 58, 86, 114, 142],\n      [6, 34, 62, 90, 118, 146],\n      [6, 30, 54, 78, 102, 126, 150],\n      [6, 24, 50, 76, 102, 128, 154],\n      [6, 28, 54, 80, 106, 132, 158],\n      [6, 32, 58, 84, 110, 136, 162],\n      [6, 26, 54, 82, 110, 138, 166],\n      [6, 30, 58, 86, 114, 142, 170]\n    ];\n    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);\n    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);\n    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);\n\n    var _this = {};\n\n    var getBCHDigit = function(data) {\n      var digit = 0;\n      while (data != 0) {\n        digit += 1;\n        data >>>= 1;\n      }\n      return digit;\n    };\n\n    _this.getBCHTypeInfo = function(data) {\n      var d = data << 10;\n      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {\n        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );\n      }\n      return ( (data << 10) | d) ^ G15_MASK;\n    };\n\n    _this.getBCHTypeNumber = function(data) {\n      var d = data << 12;\n      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {\n        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );\n      }\n      return (data << 12) | d;\n    };\n\n    _this.getPatternPosition = function(typeNumber) {\n      return PATTERN_POSITION_TABLE[typeNumber - 1];\n    };\n\n    _this.getMaskFunction = function(maskPattern) {\n\n      switch (maskPattern) {\n\n      case QRMaskPattern.PATTERN000 :\n        return function(i, j) { return (i + j) % 2 == 0; };\n      case QRMaskPattern.PATTERN001 :\n        return function(i, j) { return i % 2 == 0; };\n      case QRMaskPattern.PATTERN010 :\n        return function(i, j) { return j % 3 == 0; };\n      case QRMaskPattern.PATTERN011 :\n        return function(i, j) { return (i + j) % 3 == 0; };\n      case QRMaskPattern.PATTERN100 :\n        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };\n      case QRMaskPattern.PATTERN101 :\n        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };\n      case QRMaskPattern.PATTERN110 :\n        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };\n      case QRMaskPattern.PATTERN111 :\n        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };\n\n      default :\n        throw 'bad maskPattern:' + maskPattern;\n      }\n    };\n\n    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {\n      var a = qrPolynomial([1], 0);\n      for (var i = 0; i < errorCorrectLength; i += 1) {\n        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );\n      }\n      return a;\n    };\n\n    _this.getLengthInBits = function(mode, type) {\n\n      if (1 <= type && type < 10) {\n\n        // 1 - 9\n\n        switch(mode) {\n        case QRMode.MODE_NUMBER    : return 10;\n        case QRMode.MODE_ALPHA_NUM : return 9;\n        case QRMode.MODE_8BIT_BYTE : return 8;\n        case QRMode.MODE_KANJI     : return 8;\n        default :\n          throw 'mode:' + mode;\n        }\n\n      } else if (type < 27) {\n\n        // 10 - 26\n\n        switch(mode) {\n        case QRMode.MODE_NUMBER    : return 12;\n        case QRMode.MODE_ALPHA_NUM : return 11;\n        case QRMode.MODE_8BIT_BYTE : return 16;\n        case QRMode.MODE_KANJI     : return 10;\n        default :\n          throw 'mode:' + mode;\n        }\n\n      } else if (type < 41) {\n\n        // 27 - 40\n\n        switch(mode) {\n        case QRMode.MODE_NUMBER    : return 14;\n        case QRMode.MODE_ALPHA_NUM : return 13;\n        case QRMode.MODE_8BIT_BYTE : return 16;\n        case QRMode.MODE_KANJI     : return 12;\n        default :\n          throw 'mode:' + mode;\n        }\n\n      } else {\n        throw 'type:' + type;\n      }\n    };\n\n    _this.getLostPoint = function(qrcode) {\n\n      var moduleCount = qrcode.getModuleCount();\n\n      var lostPoint = 0;\n\n      // LEVEL1\n\n      for (var row = 0; row < moduleCount; row += 1) {\n        for (var col = 0; col < moduleCount; col += 1) {\n\n          var sameCount = 0;\n          var dark = qrcode.isDark(row, col);\n\n          for (var r = -1; r <= 1; r += 1) {\n\n            if (row + r < 0 || moduleCount <= row + r) {\n              continue;\n            }\n\n            for (var c = -1; c <= 1; c += 1) {\n\n              if (col + c < 0 || moduleCount <= col + c) {\n                continue;\n              }\n\n              if (r == 0 && c == 0) {\n                continue;\n              }\n\n              if (dark == qrcode.isDark(row + r, col + c) ) {\n                sameCount += 1;\n              }\n            }\n          }\n\n          if (sameCount > 5) {\n            lostPoint += (3 + sameCount - 5);\n          }\n        }\n      };\n\n      // LEVEL2\n\n      for (var row = 0; row < moduleCount - 1; row += 1) {\n        for (var col = 0; col < moduleCount - 1; col += 1) {\n          var count = 0;\n          if (qrcode.isDark(row, col) ) count += 1;\n          if (qrcode.isDark(row + 1, col) ) count += 1;\n          if (qrcode.isDark(row, col + 1) ) count += 1;\n          if (qrcode.isDark(row + 1, col + 1) ) count += 1;\n          if (count == 0 || count == 4) {\n            lostPoint += 3;\n          }\n        }\n      }\n\n      // LEVEL3\n\n      for (var row = 0; row < moduleCount; row += 1) {\n        for (var col = 0; col < moduleCount - 6; col += 1) {\n          if (qrcode.isDark(row, col)\n              && !qrcode.isDark(row, col + 1)\n              &&  qrcode.isDark(row, col + 2)\n              &&  qrcode.isDark(row, col + 3)\n              &&  qrcode.isDark(row, col + 4)\n              && !qrcode.isDark(row, col + 5)\n              &&  qrcode.isDark(row, col + 6) ) {\n            lostPoint += 40;\n          }\n        }\n      }\n\n      for (var col = 0; col < moduleCount; col += 1) {\n        for (var row = 0; row < moduleCount - 6; row += 1) {\n          if (qrcode.isDark(row, col)\n              && !qrcode.isDark(row + 1, col)\n              &&  qrcode.isDark(row + 2, col)\n              &&  qrcode.isDark(row + 3, col)\n              &&  qrcode.isDark(row + 4, col)\n              && !qrcode.isDark(row + 5, col)\n              &&  qrcode.isDark(row + 6, col) ) {\n            lostPoint += 40;\n          }\n        }\n      }\n\n      // LEVEL4\n\n      var darkCount = 0;\n\n      for (var col = 0; col < moduleCount; col += 1) {\n        for (var row = 0; row < moduleCount; row += 1) {\n          if (qrcode.isDark(row, col) ) {\n            darkCount += 1;\n          }\n        }\n      }\n\n      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;\n      lostPoint += ratio * 10;\n\n      return lostPoint;\n    };\n\n    return _this;\n  }();\n\n  //---------------------------------------------------------------------\n  // QRMath\n  //---------------------------------------------------------------------\n\n  var QRMath = function() {\n\n    var EXP_TABLE = new Array(256);\n    var LOG_TABLE = new Array(256);\n\n    // initialize tables\n    for (var i = 0; i < 8; i += 1) {\n      EXP_TABLE[i] = 1 << i;\n    }\n    for (var i = 8; i < 256; i += 1) {\n      EXP_TABLE[i] = EXP_TABLE[i - 4]\n        ^ EXP_TABLE[i - 5]\n        ^ EXP_TABLE[i - 6]\n        ^ EXP_TABLE[i - 8];\n    }\n    for (var i = 0; i < 255; i += 1) {\n      LOG_TABLE[EXP_TABLE[i] ] = i;\n    }\n\n    var _this = {};\n\n    _this.glog = function(n) {\n\n      if (n < 1) {\n        throw 'glog(' + n + ')';\n      }\n\n      return LOG_TABLE[n];\n    };\n\n    _this.gexp = function(n) {\n\n      while (n < 0) {\n        n += 255;\n      }\n\n      while (n >= 256) {\n        n -= 255;\n      }\n\n      return EXP_TABLE[n];\n    };\n\n    return _this;\n  }();\n\n  //---------------------------------------------------------------------\n  // qrPolynomial\n  //---------------------------------------------------------------------\n\n  function qrPolynomial(num, shift) {\n\n    if (typeof num.length == 'undefined') {\n      throw num.length + '/' + shift;\n    }\n\n    var _num = function() {\n      var offset = 0;\n      while (offset < num.length && num[offset] == 0) {\n        offset += 1;\n      }\n      var _num = new Array(num.length - offset + shift);\n      for (var i = 0; i < num.length - offset; i += 1) {\n        _num[i] = num[i + offset];\n      }\n      return _num;\n    }();\n\n    var _this = {};\n\n    _this.getAt = function(index) {\n      return _num[index];\n    };\n\n    _this.getLength = function() {\n      return _num.length;\n    };\n\n    _this.multiply = function(e) {\n\n      var num = new Array(_this.getLength() + e.getLength() - 1);\n\n      for (var i = 0; i < _this.getLength(); i += 1) {\n        for (var j = 0; j < e.getLength(); j += 1) {\n          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );\n        }\n      }\n\n      return qrPolynomial(num, 0);\n    };\n\n    _this.mod = function(e) {\n\n      if (_this.getLength() - e.getLength() < 0) {\n        return _this;\n      }\n\n      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );\n\n      var num = new Array(_this.getLength() );\n      for (var i = 0; i < _this.getLength(); i += 1) {\n        num[i] = _this.getAt(i);\n      }\n\n      for (var i = 0; i < e.getLength(); i += 1) {\n        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);\n      }\n\n      // recursive call\n      return qrPolynomial(num, 0).mod(e);\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // QRRSBlock\n  //---------------------------------------------------------------------\n\n  var QRRSBlock = function() {\n\n    var RS_BLOCK_TABLE = [\n\n      // L\n      // M\n      // Q\n      // H\n\n      // 1\n      [1, 26, 19],\n      [1, 26, 16],\n      [1, 26, 13],\n      [1, 26, 9],\n\n      // 2\n      [1, 44, 34],\n      [1, 44, 28],\n      [1, 44, 22],\n      [1, 44, 16],\n\n      // 3\n      [1, 70, 55],\n      [1, 70, 44],\n      [2, 35, 17],\n      [2, 35, 13],\n\n      // 4\n      [1, 100, 80],\n      [2, 50, 32],\n      [2, 50, 24],\n      [4, 25, 9],\n\n      // 5\n      [1, 134, 108],\n      [2, 67, 43],\n      [2, 33, 15, 2, 34, 16],\n      [2, 33, 11, 2, 34, 12],\n\n      // 6\n      [2, 86, 68],\n      [4, 43, 27],\n      [4, 43, 19],\n      [4, 43, 15],\n\n      // 7\n      [2, 98, 78],\n      [4, 49, 31],\n      [2, 32, 14, 4, 33, 15],\n      [4, 39, 13, 1, 40, 14],\n\n      // 8\n      [2, 121, 97],\n      [2, 60, 38, 2, 61, 39],\n      [4, 40, 18, 2, 41, 19],\n      [4, 40, 14, 2, 41, 15],\n\n      // 9\n      [2, 146, 116],\n      [3, 58, 36, 2, 59, 37],\n      [4, 36, 16, 4, 37, 17],\n      [4, 36, 12, 4, 37, 13],\n\n      // 10\n      [2, 86, 68, 2, 87, 69],\n      [4, 69, 43, 1, 70, 44],\n      [6, 43, 19, 2, 44, 20],\n      [6, 43, 15, 2, 44, 16],\n\n      // 11\n      [4, 101, 81],\n      [1, 80, 50, 4, 81, 51],\n      [4, 50, 22, 4, 51, 23],\n      [3, 36, 12, 8, 37, 13],\n\n      // 12\n      [2, 116, 92, 2, 117, 93],\n      [6, 58, 36, 2, 59, 37],\n      [4, 46, 20, 6, 47, 21],\n      [7, 42, 14, 4, 43, 15],\n\n      // 13\n      [4, 133, 107],\n      [8, 59, 37, 1, 60, 38],\n      [8, 44, 20, 4, 45, 21],\n      [12, 33, 11, 4, 34, 12],\n\n      // 14\n      [3, 145, 115, 1, 146, 116],\n      [4, 64, 40, 5, 65, 41],\n      [11, 36, 16, 5, 37, 17],\n      [11, 36, 12, 5, 37, 13],\n\n      // 15\n      [5, 109, 87, 1, 110, 88],\n      [5, 65, 41, 5, 66, 42],\n      [5, 54, 24, 7, 55, 25],\n      [11, 36, 12, 7, 37, 13],\n\n      // 16\n      [5, 122, 98, 1, 123, 99],\n      [7, 73, 45, 3, 74, 46],\n      [15, 43, 19, 2, 44, 20],\n      [3, 45, 15, 13, 46, 16],\n\n      // 17\n      [1, 135, 107, 5, 136, 108],\n      [10, 74, 46, 1, 75, 47],\n      [1, 50, 22, 15, 51, 23],\n      [2, 42, 14, 17, 43, 15],\n\n      // 18\n      [5, 150, 120, 1, 151, 121],\n      [9, 69, 43, 4, 70, 44],\n      [17, 50, 22, 1, 51, 23],\n      [2, 42, 14, 19, 43, 15],\n\n      // 19\n      [3, 141, 113, 4, 142, 114],\n      [3, 70, 44, 11, 71, 45],\n      [17, 47, 21, 4, 48, 22],\n      [9, 39, 13, 16, 40, 14],\n\n      // 20\n      [3, 135, 107, 5, 136, 108],\n      [3, 67, 41, 13, 68, 42],\n      [15, 54, 24, 5, 55, 25],\n      [15, 43, 15, 10, 44, 16],\n\n      // 21\n      [4, 144, 116, 4, 145, 117],\n      [17, 68, 42],\n      [17, 50, 22, 6, 51, 23],\n      [19, 46, 16, 6, 47, 17],\n\n      // 22\n      [2, 139, 111, 7, 140, 112],\n      [17, 74, 46],\n      [7, 54, 24, 16, 55, 25],\n      [34, 37, 13],\n\n      // 23\n      [4, 151, 121, 5, 152, 122],\n      [4, 75, 47, 14, 76, 48],\n      [11, 54, 24, 14, 55, 25],\n      [16, 45, 15, 14, 46, 16],\n\n      // 24\n      [6, 147, 117, 4, 148, 118],\n      [6, 73, 45, 14, 74, 46],\n      [11, 54, 24, 16, 55, 25],\n      [30, 46, 16, 2, 47, 17],\n\n      // 25\n      [8, 132, 106, 4, 133, 107],\n      [8, 75, 47, 13, 76, 48],\n      [7, 54, 24, 22, 55, 25],\n      [22, 45, 15, 13, 46, 16],\n\n      // 26\n      [10, 142, 114, 2, 143, 115],\n      [19, 74, 46, 4, 75, 47],\n      [28, 50, 22, 6, 51, 23],\n      [33, 46, 16, 4, 47, 17],\n\n      // 27\n      [8, 152, 122, 4, 153, 123],\n      [22, 73, 45, 3, 74, 46],\n      [8, 53, 23, 26, 54, 24],\n      [12, 45, 15, 28, 46, 16],\n\n      // 28\n      [3, 147, 117, 10, 148, 118],\n      [3, 73, 45, 23, 74, 46],\n      [4, 54, 24, 31, 55, 25],\n      [11, 45, 15, 31, 46, 16],\n\n      // 29\n      [7, 146, 116, 7, 147, 117],\n      [21, 73, 45, 7, 74, 46],\n      [1, 53, 23, 37, 54, 24],\n      [19, 45, 15, 26, 46, 16],\n\n      // 30\n      [5, 145, 115, 10, 146, 116],\n      [19, 75, 47, 10, 76, 48],\n      [15, 54, 24, 25, 55, 25],\n      [23, 45, 15, 25, 46, 16],\n\n      // 31\n      [13, 145, 115, 3, 146, 116],\n      [2, 74, 46, 29, 75, 47],\n      [42, 54, 24, 1, 55, 25],\n      [23, 45, 15, 28, 46, 16],\n\n      // 32\n      [17, 145, 115],\n      [10, 74, 46, 23, 75, 47],\n      [10, 54, 24, 35, 55, 25],\n      [19, 45, 15, 35, 46, 16],\n\n      // 33\n      [17, 145, 115, 1, 146, 116],\n      [14, 74, 46, 21, 75, 47],\n      [29, 54, 24, 19, 55, 25],\n      [11, 45, 15, 46, 46, 16],\n\n      // 34\n      [13, 145, 115, 6, 146, 116],\n      [14, 74, 46, 23, 75, 47],\n      [44, 54, 24, 7, 55, 25],\n      [59, 46, 16, 1, 47, 17],\n\n      // 35\n      [12, 151, 121, 7, 152, 122],\n      [12, 75, 47, 26, 76, 48],\n      [39, 54, 24, 14, 55, 25],\n      [22, 45, 15, 41, 46, 16],\n\n      // 36\n      [6, 151, 121, 14, 152, 122],\n      [6, 75, 47, 34, 76, 48],\n      [46, 54, 24, 10, 55, 25],\n      [2, 45, 15, 64, 46, 16],\n\n      // 37\n      [17, 152, 122, 4, 153, 123],\n      [29, 74, 46, 14, 75, 47],\n      [49, 54, 24, 10, 55, 25],\n      [24, 45, 15, 46, 46, 16],\n\n      // 38\n      [4, 152, 122, 18, 153, 123],\n      [13, 74, 46, 32, 75, 47],\n      [48, 54, 24, 14, 55, 25],\n      [42, 45, 15, 32, 46, 16],\n\n      // 39\n      [20, 147, 117, 4, 148, 118],\n      [40, 75, 47, 7, 76, 48],\n      [43, 54, 24, 22, 55, 25],\n      [10, 45, 15, 67, 46, 16],\n\n      // 40\n      [19, 148, 118, 6, 149, 119],\n      [18, 75, 47, 31, 76, 48],\n      [34, 54, 24, 34, 55, 25],\n      [20, 45, 15, 61, 46, 16]\n    ];\n\n    var qrRSBlock = function(totalCount, dataCount) {\n      var _this = {};\n      _this.totalCount = totalCount;\n      _this.dataCount = dataCount;\n      return _this;\n    };\n\n    var _this = {};\n\n    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {\n\n      switch(errorCorrectionLevel) {\n      case QRErrorCorrectionLevel.L :\n        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];\n      case QRErrorCorrectionLevel.M :\n        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];\n      case QRErrorCorrectionLevel.Q :\n        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];\n      case QRErrorCorrectionLevel.H :\n        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];\n      default :\n        return undefined;\n      }\n    };\n\n    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {\n\n      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);\n\n      if (typeof rsBlock == 'undefined') {\n        throw 'bad rs block @ typeNumber:' + typeNumber +\n            '/errorCorrectionLevel:' + errorCorrectionLevel;\n      }\n\n      var length = rsBlock.length / 3;\n\n      var list = [];\n\n      for (var i = 0; i < length; i += 1) {\n\n        var count = rsBlock[i * 3 + 0];\n        var totalCount = rsBlock[i * 3 + 1];\n        var dataCount = rsBlock[i * 3 + 2];\n\n        for (var j = 0; j < count; j += 1) {\n          list.push(qrRSBlock(totalCount, dataCount) );\n        }\n      }\n\n      return list;\n    };\n\n    return _this;\n  }();\n\n  //---------------------------------------------------------------------\n  // qrBitBuffer\n  //---------------------------------------------------------------------\n\n  var qrBitBuffer = function() {\n\n    var _buffer = [];\n    var _length = 0;\n\n    var _this = {};\n\n    _this.getBuffer = function() {\n      return _buffer;\n    };\n\n    _this.getAt = function(index) {\n      var bufIndex = Math.floor(index / 8);\n      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;\n    };\n\n    _this.put = function(num, length) {\n      for (var i = 0; i < length; i += 1) {\n        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);\n      }\n    };\n\n    _this.getLengthInBits = function() {\n      return _length;\n    };\n\n    _this.putBit = function(bit) {\n\n      var bufIndex = Math.floor(_length / 8);\n      if (_buffer.length <= bufIndex) {\n        _buffer.push(0);\n      }\n\n      if (bit) {\n        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );\n      }\n\n      _length += 1;\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // qrNumber\n  //---------------------------------------------------------------------\n\n  var qrNumber = function(data) {\n\n    var _mode = QRMode.MODE_NUMBER;\n    var _data = data;\n\n    var _this = {};\n\n    _this.getMode = function() {\n      return _mode;\n    };\n\n    _this.getLength = function(buffer) {\n      return _data.length;\n    };\n\n    _this.write = function(buffer) {\n\n      var data = _data;\n\n      var i = 0;\n\n      while (i + 2 < data.length) {\n        buffer.put(strToNum(data.substring(i, i + 3) ), 10);\n        i += 3;\n      }\n\n      if (i < data.length) {\n        if (data.length - i == 1) {\n          buffer.put(strToNum(data.substring(i, i + 1) ), 4);\n        } else if (data.length - i == 2) {\n          buffer.put(strToNum(data.substring(i, i + 2) ), 7);\n        }\n      }\n    };\n\n    var strToNum = function(s) {\n      var num = 0;\n      for (var i = 0; i < s.length; i += 1) {\n        num = num * 10 + chatToNum(s.charAt(i) );\n      }\n      return num;\n    };\n\n    var chatToNum = function(c) {\n      if ('0' <= c && c <= '9') {\n        return c.charCodeAt(0) - '0'.charCodeAt(0);\n      }\n      throw 'illegal char :' + c;\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // qrAlphaNum\n  //---------------------------------------------------------------------\n\n  var qrAlphaNum = function(data) {\n\n    var _mode = QRMode.MODE_ALPHA_NUM;\n    var _data = data;\n\n    var _this = {};\n\n    _this.getMode = function() {\n      return _mode;\n    };\n\n    _this.getLength = function(buffer) {\n      return _data.length;\n    };\n\n    _this.write = function(buffer) {\n\n      var s = _data;\n\n      var i = 0;\n\n      while (i + 1 < s.length) {\n        buffer.put(\n          getCode(s.charAt(i) ) * 45 +\n          getCode(s.charAt(i + 1) ), 11);\n        i += 2;\n      }\n\n      if (i < s.length) {\n        buffer.put(getCode(s.charAt(i) ), 6);\n      }\n    };\n\n    var getCode = function(c) {\n\n      if ('0' <= c && c <= '9') {\n        return c.charCodeAt(0) - '0'.charCodeAt(0);\n      } else if ('A' <= c && c <= 'Z') {\n        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;\n      } else {\n        switch (c) {\n        case ' ' : return 36;\n        case '$' : return 37;\n        case '%' : return 38;\n        case '*' : return 39;\n        case '+' : return 40;\n        case '-' : return 41;\n        case '.' : return 42;\n        case '/' : return 43;\n        case ':' : return 44;\n        default :\n          throw 'illegal char :' + c;\n        }\n      }\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // qr8BitByte\n  //---------------------------------------------------------------------\n\n  var qr8BitByte = function(data) {\n\n    var _mode = QRMode.MODE_8BIT_BYTE;\n    var _data = data;\n    var _bytes = qrcode.stringToBytes(data);\n\n    var _this = {};\n\n    _this.getMode = function() {\n      return _mode;\n    };\n\n    _this.getLength = function(buffer) {\n      return _bytes.length;\n    };\n\n    _this.write = function(buffer) {\n      for (var i = 0; i < _bytes.length; i += 1) {\n        buffer.put(_bytes[i], 8);\n      }\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // qrKanji\n  //---------------------------------------------------------------------\n\n  var qrKanji = function(data) {\n\n    var _mode = QRMode.MODE_KANJI;\n    var _data = data;\n\n    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];\n    if (!stringToBytes) {\n      throw 'sjis not supported.';\n    }\n    !function(c, code) {\n      // self test for sjis support.\n      var test = stringToBytes(c);\n      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {\n        throw 'sjis not supported.';\n      }\n    }('\\u53cb', 0x9746);\n\n    var _bytes = stringToBytes(data);\n\n    var _this = {};\n\n    _this.getMode = function() {\n      return _mode;\n    };\n\n    _this.getLength = function(buffer) {\n      return ~~(_bytes.length / 2);\n    };\n\n    _this.write = function(buffer) {\n\n      var data = _bytes;\n\n      var i = 0;\n\n      while (i + 1 < data.length) {\n\n        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);\n\n        if (0x8140 <= c && c <= 0x9FFC) {\n          c -= 0x8140;\n        } else if (0xE040 <= c && c <= 0xEBBF) {\n          c -= 0xC140;\n        } else {\n          throw 'illegal char at ' + (i + 1) + '/' + c;\n        }\n\n        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);\n\n        buffer.put(c, 13);\n\n        i += 2;\n      }\n\n      if (i < data.length) {\n        throw 'illegal char at ' + (i + 1);\n      }\n    };\n\n    return _this;\n  };\n\n  //=====================================================================\n  // GIF Support etc.\n  //\n\n  //---------------------------------------------------------------------\n  // byteArrayOutputStream\n  //---------------------------------------------------------------------\n\n  var byteArrayOutputStream = function() {\n\n    var _bytes = [];\n\n    var _this = {};\n\n    _this.writeByte = function(b) {\n      _bytes.push(b & 0xff);\n    };\n\n    _this.writeShort = function(i) {\n      _this.writeByte(i);\n      _this.writeByte(i >>> 8);\n    };\n\n    _this.writeBytes = function(b, off, len) {\n      off = off || 0;\n      len = len || b.length;\n      for (var i = 0; i < len; i += 1) {\n        _this.writeByte(b[i + off]);\n      }\n    };\n\n    _this.writeString = function(s) {\n      for (var i = 0; i < s.length; i += 1) {\n        _this.writeByte(s.charCodeAt(i) );\n      }\n    };\n\n    _this.toByteArray = function() {\n      return _bytes;\n    };\n\n    _this.toString = function() {\n      var s = '';\n      s += '[';\n      for (var i = 0; i < _bytes.length; i += 1) {\n        if (i > 0) {\n          s += ',';\n        }\n        s += _bytes[i];\n      }\n      s += ']';\n      return s;\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // base64EncodeOutputStream\n  //---------------------------------------------------------------------\n\n  var base64EncodeOutputStream = function() {\n\n    var _buffer = 0;\n    var _buflen = 0;\n    var _length = 0;\n    var _base64 = '';\n\n    var _this = {};\n\n    var writeEncoded = function(b) {\n      _base64 += String.fromCharCode(encode(b & 0x3f) );\n    };\n\n    var encode = function(n) {\n      if (n < 0) {\n        // error.\n      } else if (n < 26) {\n        return 0x41 + n;\n      } else if (n < 52) {\n        return 0x61 + (n - 26);\n      } else if (n < 62) {\n        return 0x30 + (n - 52);\n      } else if (n == 62) {\n        return 0x2b;\n      } else if (n == 63) {\n        return 0x2f;\n      }\n      throw 'n:' + n;\n    };\n\n    _this.writeByte = function(n) {\n\n      _buffer = (_buffer << 8) | (n & 0xff);\n      _buflen += 8;\n      _length += 1;\n\n      while (_buflen >= 6) {\n        writeEncoded(_buffer >>> (_buflen - 6) );\n        _buflen -= 6;\n      }\n    };\n\n    _this.flush = function() {\n\n      if (_buflen > 0) {\n        writeEncoded(_buffer << (6 - _buflen) );\n        _buffer = 0;\n        _buflen = 0;\n      }\n\n      if (_length % 3 != 0) {\n        // padding\n        var padlen = 3 - _length % 3;\n        for (var i = 0; i < padlen; i += 1) {\n          _base64 += '=';\n        }\n      }\n    };\n\n    _this.toString = function() {\n      return _base64;\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // base64DecodeInputStream\n  //---------------------------------------------------------------------\n\n  var base64DecodeInputStream = function(str) {\n\n    var _str = str;\n    var _pos = 0;\n    var _buffer = 0;\n    var _buflen = 0;\n\n    var _this = {};\n\n    _this.read = function() {\n\n      while (_buflen < 8) {\n\n        if (_pos >= _str.length) {\n          if (_buflen == 0) {\n            return -1;\n          }\n          throw 'unexpected end of file./' + _buflen;\n        }\n\n        var c = _str.charAt(_pos);\n        _pos += 1;\n\n        if (c == '=') {\n          _buflen = 0;\n          return -1;\n        } else if (c.match(/^\\s$/) ) {\n          // ignore if whitespace.\n          continue;\n        }\n\n        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );\n        _buflen += 6;\n      }\n\n      var n = (_buffer >>> (_buflen - 8) ) & 0xff;\n      _buflen -= 8;\n      return n;\n    };\n\n    var decode = function(c) {\n      if (0x41 <= c && c <= 0x5a) {\n        return c - 0x41;\n      } else if (0x61 <= c && c <= 0x7a) {\n        return c - 0x61 + 26;\n      } else if (0x30 <= c && c <= 0x39) {\n        return c - 0x30 + 52;\n      } else if (c == 0x2b) {\n        return 62;\n      } else if (c == 0x2f) {\n        return 63;\n      } else {\n        throw 'c:' + c;\n      }\n    };\n\n    return _this;\n  };\n\n  //---------------------------------------------------------------------\n  // gifImage (B/W)\n  //---------------------------------------------------------------------\n\n  var gifImage = function(width, height) {\n\n    var _width = width;\n    var _height = height;\n    var _data = new Array(width * height);\n\n    var _this = {};\n\n    _this.setPixel = function(x, y, pixel) {\n      _data[y * _width + x] = pixel;\n    };\n\n    _this.write = function(out) {\n\n      //---------------------------------\n      // GIF Signature\n\n      out.writeString('GIF87a');\n\n      //---------------------------------\n      // Screen Descriptor\n\n      out.writeShort(_width);\n      out.writeShort(_height);\n\n      out.writeByte(0x80); // 2bit\n      out.writeByte(0);\n      out.writeByte(0);\n\n      //---------------------------------\n      // Global Color Map\n\n      // black\n      out.writeByte(0x00);\n      out.writeByte(0x00);\n      out.writeByte(0x00);\n\n      // white\n      out.writeByte(0xff);\n      out.writeByte(0xff);\n      out.writeByte(0xff);\n\n      //---------------------------------\n      // Image Descriptor\n\n      out.writeString(',');\n      out.writeShort(0);\n      out.writeShort(0);\n      out.writeShort(_width);\n      out.writeShort(_height);\n      out.writeByte(0);\n\n      //---------------------------------\n      // Local Color Map\n\n      //---------------------------------\n      // Raster Data\n\n      var lzwMinCodeSize = 2;\n      var raster = getLZWRaster(lzwMinCodeSize);\n\n      out.writeByte(lzwMinCodeSize);\n\n      var offset = 0;\n\n      while (raster.length - offset > 255) {\n        out.writeByte(255);\n        out.writeBytes(raster, offset, 255);\n        offset += 255;\n      }\n\n      out.writeByte(raster.length - offset);\n      out.writeBytes(raster, offset, raster.length - offset);\n      out.writeByte(0x00);\n\n      //---------------------------------\n      // GIF Terminator\n      out.writeString(';');\n    };\n\n    var bitOutputStream = function(out) {\n\n      var _out = out;\n      var _bitLength = 0;\n      var _bitBuffer = 0;\n\n      var _this = {};\n\n      _this.write = function(data, length) {\n\n        if ( (data >>> length) != 0) {\n          throw 'length over';\n        }\n\n        while (_bitLength + length >= 8) {\n          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );\n          length -= (8 - _bitLength);\n          data >>>= (8 - _bitLength);\n          _bitBuffer = 0;\n          _bitLength = 0;\n        }\n\n        _bitBuffer = (data << _bitLength) | _bitBuffer;\n        _bitLength = _bitLength + length;\n      };\n\n      _this.flush = function() {\n        if (_bitLength > 0) {\n          _out.writeByte(_bitBuffer);\n        }\n      };\n\n      return _this;\n    };\n\n    var getLZWRaster = function(lzwMinCodeSize) {\n\n      var clearCode = 1 << lzwMinCodeSize;\n      var endCode = (1 << lzwMinCodeSize) + 1;\n      var bitLength = lzwMinCodeSize + 1;\n\n      // Setup LZWTable\n      var table = lzwTable();\n\n      for (var i = 0; i < clearCode; i += 1) {\n        table.add(String.fromCharCode(i) );\n      }\n      table.add(String.fromCharCode(clearCode) );\n      table.add(String.fromCharCode(endCode) );\n\n      var byteOut = byteArrayOutputStream();\n      var bitOut = bitOutputStream(byteOut);\n\n      // clear code\n      bitOut.write(clearCode, bitLength);\n\n      var dataIndex = 0;\n\n      var s = String.fromCharCode(_data[dataIndex]);\n      dataIndex += 1;\n\n      while (dataIndex < _data.length) {\n\n        var c = String.fromCharCode(_data[dataIndex]);\n        dataIndex += 1;\n\n        if (table.contains(s + c) ) {\n\n          s = s + c;\n\n        } else {\n\n          bitOut.write(table.indexOf(s), bitLength);\n\n          if (table.size() < 0xfff) {\n\n            if (table.size() == (1 << bitLength) ) {\n              bitLength += 1;\n            }\n\n            table.add(s + c);\n          }\n\n          s = c;\n        }\n      }\n\n      bitOut.write(table.indexOf(s), bitLength);\n\n      // end code\n      bitOut.write(endCode, bitLength);\n\n      bitOut.flush();\n\n      return byteOut.toByteArray();\n    };\n\n    var lzwTable = function() {\n\n      var _map = {};\n      var _size = 0;\n\n      var _this = {};\n\n      _this.add = function(key) {\n        if (_this.contains(key) ) {\n          throw 'dup key:' + key;\n        }\n        _map[key] = _size;\n        _size += 1;\n      };\n\n      _this.size = function() {\n        return _size;\n      };\n\n      _this.indexOf = function(key) {\n        return _map[key];\n      };\n\n      _this.contains = function(key) {\n        return typeof _map[key] != 'undefined';\n      };\n\n      return _this;\n    };\n\n    return _this;\n  };\n\n  var createDataURL = function(width, height, getPixel) {\n    var gif = gifImage(width, height);\n    for (var y = 0; y < height; y += 1) {\n      for (var x = 0; x < width; x += 1) {\n        gif.setPixel(x, y, getPixel(x, y) );\n      }\n    }\n\n    var b = byteArrayOutputStream();\n    gif.write(b);\n\n    var base64 = base64EncodeOutputStream();\n    var bytes = b.toByteArray();\n    for (var i = 0; i < bytes.length; i += 1) {\n      base64.writeByte(bytes[i]);\n    }\n    base64.flush();\n\n    return 'data:image/gif;base64,' + base64;\n  };\n\n  //---------------------------------------------------------------------\n  // returns qrcode function.\n\n  return qrcode;\n}();\n\n// multibyte support\n!function() {\n\n  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {\n    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array\n    function toUTF8Array(str) {\n      var utf8 = [];\n      for (var i=0; i < str.length; i++) {\n        var charcode = str.charCodeAt(i);\n        if (charcode < 0x80) utf8.push(charcode);\n        else if (charcode < 0x800) {\n          utf8.push(0xc0 | (charcode >> 6),\n              0x80 | (charcode & 0x3f));\n        }\n        else if (charcode < 0xd800 || charcode >= 0xe000) {\n          utf8.push(0xe0 | (charcode >> 12),\n              0x80 | ((charcode>>6) & 0x3f),\n              0x80 | (charcode & 0x3f));\n        }\n        // surrogate pair\n        else {\n          i++;\n          // UTF-16 encodes 0x10000-0x10FFFF by\n          // subtracting 0x10000 and splitting the\n          // 20 bits of 0x0-0xFFFFF into two halves\n          charcode = 0x10000 + (((charcode & 0x3ff)<<10)\n            | (str.charCodeAt(i) & 0x3ff));\n          utf8.push(0xf0 | (charcode >>18),\n              0x80 | ((charcode>>12) & 0x3f),\n              0x80 | ((charcode>>6) & 0x3f),\n              0x80 | (charcode & 0x3f));\n        }\n      }\n      return utf8;\n    }\n    return toUTF8Array(s);\n  };\n\n}();\n\n(function (factory) {\n  if (typeof define === 'function' && define.amd) {\n      define([], factory);\n  } else if (typeof exports === 'object') {\n      module.exports = factory();\n  }\n}(function () {\n    return qrcode;\n}));\n";
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
// ---------- 订阅链接（日期+密钥，生成新的即旧的失效） ----------
// KV 模式（绑定了 SUB_KV）：当前密钥存 KV 的 'cur' 记录 {k, d}；面板点「生成新链接」即换一把新密钥，旧链接立刻 404。
// 降级模式（没绑 KV）：链接只在生成当天有效（日期段=北京时间今天），隔天自动失效。
function randKey() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function getCurrent(env) {
  if (env && env.SUB_KV) {
    let cur = null;
    try { cur = JSON.parse(await env.SUB_KV.get('cur') || 'null'); } catch { cur = null; }
    if (!cur || !cur.k) { cur = { k: randKey(), d: todayYMD() }; try { await env.SUB_KV.put('cur', JSON.stringify(cur)); } catch { } }
    return { mode: 'kv', key: cur.k, date: cur.d };
  }
  return { mode: 'daily', key: 'daily', date: todayYMD() };
}
async function rotateCurrent(env) {
  const cur = { k: randKey(), d: todayYMD() };
  if (env && env.SUB_KV) { await env.SUB_KV.put('cur', JSON.stringify(cur)); return { mode: 'kv', key: cur.k, date: cur.d }; }
  return { mode: 'daily', key: 'daily', date: todayYMD() };
}
async function subLinkValid(env, date, key) {
  if (env && env.SUB_KV) {
    let cur = null;
    try { cur = JSON.parse(await env.SUB_KV.get('cur') || 'null'); } catch { cur = null; }
    return !!cur && cur.k === key && cur.d === date;
  }
  return date === todayYMD();
}
function linksFor(origin, cur) {
  return {
    clash: origin + '/sub/clash-' + cur.date + '-' + cur.key,
    v2ray: origin + '/sub/v2ray-' + cur.date + '-' + cur.key,
  };
}
async function withEdgeCache(request, ctx, producer) {
  if (typeof caches === 'undefined' || !ctx) return producer();
  try {
    const cache = caches.default;
    const key = new Request(new URL(request.url).toString(), { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = await producer();
    const out = new Response(res.body, { status: res.status, headers: res.headers });
    out.headers.set('Cache-Control', 'public, max-age=' + EDGE_TTL);
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  } catch { return producer(); }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/qrcode.js') {
        return new Response(QR_LIB, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
      }
      if (path === '/api/health') return jsonResp({ ok: true, version: VERSION, sources: SOURCES.length, kv: !!(env && env.SUB_KV) });
      if (path === '/') {
        return new Response(PANEL_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
      }
      if (path === '/api/status') {
        return await withEdgeCache(request, ctx, async () => {
          const d = await aggregate();
          return jsonResp({ version: d.version, updatedAt: d.updatedAt, totalRaw: d.totalRaw, totalUnique: d.totalUnique, protocols: d.protocols, v2rayCount: d.v2rayCount, clashCount: d.clashCount, backfilled: d.backfilled, minOut: d.minOut, maxOut: d.maxOut, probeOk: d.probeOk, probeAlive: d.probeAlive, screenedCount: d.screenedCount, screenedInOut: d.screenedInOut, kv: !!(env && env.SUB_KV), sources: d.sources });
        });
      }
      if (path === '/api/current') {
        const cur = await getCurrent(env);
        return jsonResp({ mode: cur.mode, date: cur.date, links: linksFor(url.origin, cur) });
      }
      if (path === '/api/genlink' && request.method === 'POST') {
        if (env && env.GEN_KEY && request.headers.get('x-gen-key') !== env.GEN_KEY) {
          return jsonResp({ ok: false, error: '管理口令不正确，无法生成新链接' }, 403);
        }
        const cur = await rotateCurrent(env);
        return jsonResp({ ok: true, mode: cur.mode, date: cur.date, links: linksFor(url.origin, cur) });
      }
      const subMatch = path.match(/^\/sub\/(clash|v2ray)-(\d{8})-([a-z0-9]+)$/);
      if (subMatch) {
        if (!(await subLinkValid(env, subMatch[2], subMatch[3]))) {
          return new Response('订阅链接已失效：链接带有日期与密钥，生成新链接后旧链接立即作废。请回到面板首页获取当前链接。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        const kind = subMatch[1];
        const mime = kind === 'clash' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8';
        const fname = 'freenodepick-' + subMatch[2] + (kind === 'clash' ? '.yaml' : '.txt');
        return await withEdgeCache(request, ctx, async () => {
          const d = await aggregate();
          const body = kind === 'clash' ? d.clashBody : d.v2rayBody;
          return new Response(body, { headers: { 'Content-Type': mime, 'Content-Disposition': 'attachment; filename="' + fname + '"', 'Profile-Update-Interval': '12', 'Cache-Control': 'public, max-age=' + EDGE_TTL } });
        });
      }
      if (path.startsWith('/sub/')) {
        return new Response('订阅链接形如 /sub/clash-' + todayYMD() + '-<密钥>（带日期与密钥），请回到面板首页复制当前链接。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response('Internal Error: ' + (e && e.message || e), { status: 500 });
    }
  },
};

// ---------- 面板 ----------
const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FreeNodePick · 精选节点订阅</title>
<script src="/qrcode.js"></script>
<style>
:root{--bg:#0f1420;--card:#171e2e;--line:#26314a;--txt:#e8edf7;--dim:#93a1bb;--acc:#3b82f6;--ok:#22c55e;--bad:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:20px 14px 40px}
h1{font-size:24px;margin:6px 0 2px} .sub{color:var(--dim);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:14px}
.card h2{font-size:16px;margin:0 0 10px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat{background:#101828;border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center}
.stat b{display:block;font-size:22px;color:#fff}.stat span{font-size:12px;color:var(--dim)}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-size:13px;color:var(--dim)}
.steps b{color:var(--txt);display:block;font-size:14px;margin-bottom:4px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
code.url{background:#0b1120;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;word-break:break-all;flex:1;min-width:220px}
button,.btn{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:9px 14px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:#232f47;color:var(--txt);border:1px solid var(--line)}
button.danger{background:#b45309}
button:active{opacity:.8}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.dl{background:#101828;border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--txt);text-decoration:none;font-size:14px}
.dl small{display:block;color:var(--dim);font-size:12px;margin-top:2px}
details{margin-top:6px}summary{cursor:pointer;color:var(--txt);font-size:15px}
.src{display:flex;justify-content:space-between;gap:8px;padding:7px 2px;border-bottom:1px dashed var(--line);font-size:13px;flex-wrap:wrap}
.src a{color:var(--acc);text-decoration:none}
.badge{border-radius:20px;padding:1px 8px;font-size:12px}
.badge.ok{background:rgba(34,197,94,.15);color:var(--ok)} .badge.bad{background:rgba(239,68,68,.15);color:var(--bad)}
.badge.mode{background:rgba(59,130,246,.15);color:#93c5fd}
.warn{color:#fbbf24;font-size:13px;line-height:1.7}
.foot{color:var(--dim);font-size:12px;text-align:center;margin-top:22px;line-height:1.8}
#qrBox{margin-top:10px} #qrBox svg{background:#fff;border-radius:8px;max-width:240px;height:auto}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}.steps{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <h1>🎯 FreeNodePick 精选节点订阅</h1>
  <div class="sub">只抓 6 个为墙内用户维护的精选节点源 · 跨源去重 · Clash（带分类分流）/ v2ray 双订阅 · 数据每约 10 分钟自动刷新（<span id="upd">加载中…</span>）</div>

  <div class="card">
    <div class="stats">
      <div class="stat"><b id="statUnique">-</b><span>去重后节点</span></div>
      <div class="stat"><b id="statRaw">-</b><span>原始抓取</span></div>
      <div class="stat"><b id="statSrc">-</b><span>正常来源</span></div>
      <div class="stat"><b id="statProto">-</b><span>协议种类</span></div>
    </div>
    <div class="row"><span class="sub" id="protoLine"></span></div>
  </div>

  <div class="card">
    <h2>🚀 三步使用</h2>
    <div class="steps">
      <div><b>第 1 步：装客户端</b>在下方下载区选你的设备对应的客户端（电脑 Clash Verge、安卓 FlClash / v2rayNG、iPhone 小火箭）。</div>
      <div><b>第 2 步：一键导入</b>点下面对应客户端的「一键导入」按钮，或复制订阅链接到客户端里手动添加。</div>
      <div><b>第 3 步：更新并选节点</b>在客户端里更新订阅，选「自动选择」组或延迟最低的节点即可使用。</div>
    </div>
  </div>

  <div class="card">
    <h2>📥 订阅导入</h2>
    <div class="sub" style="margin-bottom:6px">订阅链接带有<b>日期和密钥</b>（如 …/clash-20261104-a1b2c3d4e5f6），方便识别是哪一天、哪一次生成的。每次订阅给出 <b>36~88 个</b>节点：池子大时取 88 个（各源轮换交错、家家有份），池子不足 36 个时自动用各源备用地址补抓到达标。<span id="modeLine">正在读取链接状态…</span></div>
    <div class="sub">Clash 订阅（Clash Verge / FlClash / Mihomo 系客户端用，共 <span id="clashCount">-</span> 个节点，自带 ACL4SSR 式分类分流：国外流量 / Telegram / YouTube / Netflix 等 13 个分类组 + 国内直连、广告拦截）</div>
    <div class="row">
      <code class="url" id="clashUrlText">加载中…</code>
      <button class="ghost" onclick="copyText(clashUrl,this)">复制</button>
      <button onclick="go('clash://install-config?url='+encodeURIComponent(clashUrl)+'&name='+encodeURIComponent('精选节点'))">一键导入 Clash Verge</button>
      <button onclick="go('flclash://install-config?url='+encodeURIComponent(clashUrl)+'&name='+encodeURIComponent('精选节点'))">一键导入 FlClash</button>
      <button class="ghost" onclick="toggleQr()">扫码</button>
    </div>
    <div id="qrBox" style="display:none"></div>
    <div class="sub" style="margin-top:14px">v2ray 订阅（v2rayN / v2rayNG / Shadowrocket / Hiddify 用，共 <span id="v2rayCount">-</span> 个节点）</div>
    <div class="row">
      <code class="url" id="v2rayUrlText">加载中…</code>
      <button class="ghost" onclick="copyText(v2rayUrl,this)">复制</button>
      <button onclick="go('v2rayng://install-sub?url='+encodeURIComponent(v2rayUrl))">一键导入 v2rayNG</button>
      <button onclick="go('shadowrocket://add/sub://'+btoa(v2rayUrl)+'?remark='+encodeURIComponent('精选节点'))">一键导入小火箭</button>
      <button onclick="go('hiddify://import/'+v2rayUrl)">一键导入 Hiddify</button>
    </div>
    <div class="row" style="margin-top:16px">
      <button class="danger" id="genBtn" onclick="genLink()">🔄 生成新链接（旧链接立即失效）</button>
      <span class="sub" id="genNote"></span>
    </div>
    <div class="sub" style="margin-top:12px">🔎 节点筛选：订阅里的节点都先过筛——优先选<b>通过本站每 2 小时真测活</b>的节点（本次池中命中 <span id="screenedCount">-</span> 个、入选 <span id="screenedInOut">-</span> 个，按实测延迟排在最前），其余按来源可信度补位；带推广字样的条目和同一主机扎堆的会被剔除。</div>
  </div>

  <div class="card">
    <h2>💻 客户端下载（GitHub 官方最新版）</h2>
    <div class="grid">
      <a class="dl" href="https://github.com/2dust/v2rayN/releases/latest/download/v2rayN-windows-64.zip">v2rayN<small>Windows · 直接下载最新版 zip</small></a>
      <a class="dl" href="https://github.com/clash-verge-rev/clash-verge-rev/releases/latest">Clash Verge Rev<small>Windows / macOS · 最新版页面</small></a>
      <a class="dl" href="https://github.com/chen08209/FlClash/releases/latest">FlClash<small>Android · 最新版页面</small></a>
      <a class="dl" href="https://github.com/2dust/v2rayNG/releases/latest">v2rayNG<small>Android · 最新版页面</small></a>
      <a class="dl" href="https://github.com/MetaCubeX/ClashMetaForAndroid/releases/latest">Clash Meta for Android<small>Android · 最新版页面</small></a>
      <a class="dl" href="https://github.com/hiddify/hiddify-app/releases/latest">Hiddify<small>全平台 · 最新版页面</small></a>
      <a class="dl" href="https://apps.apple.com/us/app/shadowrocket/id932747118">Shadowrocket（小火箭）<small>iOS · App Store（需外区账号）</small></a>
    </div>
  </div>

  <div class="card">
    <h2>📚 节点来源与实时状态（共 6 个精选源）</h2>
    <details>
      <summary>展开查看全部来源（默认折叠）</summary>
      <div id="srcList" style="margin-top:8px"><div class="sub">加载中…</div></div>
    </details>
    <div class="sub" style="margin-top:8px">这 6 个源都是为国内用户筛选维护的节点池：end-gfw 与周润发公益是人工维护的公益订阅，ChromeGo/EdgeGo 是翻墙工具包的官方节点池，ermaozi 只收它自己筛过的「可达」名单，ripaojiedian 主打永久免费，FreeNodeBiz 是持续更新的精选站。本站只做聚合、格式转换与去重，不运营任何节点；免费节点随时可能失效，请在客户端里用「自动选择」组挑当前可用的。</div>
  </div>

  <div class="card">
    <h2>⚠️ 使用须知</h2>
    <div class="warn">
      免费节点来自公开网络，寿命短、速度不稳定是常态，某个节点连不上时换一个或等订阅刷新即可。<br>
      请勿用免费节点登录重要账号（网银、支付、主邮箱等）或传输敏感信息；仅供学习测试，请遵守当地法律法规。
    </div>
  </div>

  <div class="foot">FreeNodePick v<span id="ver">-</span> · 本页面与订阅由 Cloudflare 边缘节点实时生成 · 节点版权归各来源项目所有</div>
</div>
<script>
var clashUrl = '', v2rayUrl = '', genKey = '', qrDone = false;
function go(u){ location.href = u; }
function copyText(t, btn){
  if (!t) return;
  function done(){ var o = btn.textContent; btn.textContent = '已复制 ✓'; setTimeout(function(){ btn.textContent = o; }, 1500); }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done).catch(function(){ fallback(); });
  else fallback();
  function fallback(){ var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(e){} document.body.removeChild(ta); done(); }
}
function applyLinks(d){
  clashUrl = d.links.clash; v2rayUrl = d.links.v2ray;
  document.getElementById('clashUrlText').textContent = clashUrl;
  document.getElementById('v2rayUrlText').textContent = v2rayUrl;
  var ml = document.getElementById('modeLine');
  if (d.mode === 'kv') ml.innerHTML = '当前模式：<span class="badge mode">链接轮换已启用</span> 点下方「生成新链接」后，这批链接立即作废、换成新的。';
  else ml.innerHTML = '当前模式：<span class="badge mode">按天失效</span> 未绑定 KV，链接只在生成当天有效，隔天请回本页重新导入；绑定 KV 后可随时一键作废旧链接（见部署说明）。';
  qrDone = false; document.getElementById('qrBox').style.display = 'none';
}
function toggleQr(){
  var box = document.getElementById('qrBox');
  if (box.style.display === 'none') {
    box.style.display = 'block';
    if (!qrDone && typeof qrcode !== 'undefined' && clashUrl) {
      try { var qr = qrcode(0, 'M'); qr.addData(clashUrl); qr.make(); box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 12, scalable: true }) + '<div class="sub">手机扫码，导入 Clash 订阅</div>'; qrDone = true; } catch(e){ box.innerHTML = '<div class="sub">二维码生成失败，请复制链接导入</div>'; }
    }
  } else box.style.display = 'none';
}
function genLink(){
  var note = document.getElementById('genNote');
  note.textContent = '正在生成…';
  var headers = {}; if (genKey) headers['x-gen-key'] = genKey;
  fetch('/api/genlink', { method: 'POST', headers: headers }).then(function(r){
    if (r.status === 403) {
      var k = prompt('本站设置了管理口令，请输入口令后生成新链接：');
      if (k) { genKey = k; genLink(); } else note.textContent = '已取消';
      return null;
    }
    return r.json();
  }).then(function(d){
    if (!d) return;
    if (d.ok) { applyLinks(d); note.textContent = d.mode === 'kv' ? '新链接已生成，旧链接已失效 ✓ 请把新链接重新导入客户端。' : '已刷新为今日链接（按天模式）；绑定 KV 后生成新链接才能立即作废旧链接。'; }
    else note.textContent = '生成失败：' + (d.error || '未知错误');
  }).catch(function(){ note.textContent = '生成失败，请重试'; });
}
fetch('/api/current').then(function(r){ return r.json(); }).then(function(d){ applyLinks(d); }).catch(function(){ document.getElementById('modeLine').textContent = '链接加载失败，请刷新页面'; });
fetch('/api/status').then(function(r){ return r.json(); }).then(function(d){
  document.getElementById('upd').textContent = '更新于 ' + new Date(d.updatedAt).toLocaleString();
  document.getElementById('ver').textContent = d.version;
  document.getElementById('statUnique').textContent = d.totalUnique;
  document.getElementById('statRaw').textContent = d.totalRaw;
  var ok = 0; d.sources.forEach(function(s){ if (s.ok) ok++; });
  document.getElementById('statSrc').textContent = ok + '/' + d.sources.length;
  document.getElementById('statProto').textContent = Object.keys(d.protocols).length;
  document.getElementById('clashCount').textContent = d.clashCount;
  document.getElementById('screenedCount').textContent = d.probeOk ? d.screenedCount : '0（测活名单暂不可用）';
  document.getElementById('screenedInOut').textContent = d.screenedInOut;
  document.getElementById('v2rayCount').textContent = d.v2rayCount;
  var pl = Object.keys(d.protocols).map(function(k){ return k + ' ' + d.protocols[k]; }).join(' · ');
  document.getElementById('protoLine').textContent = pl;
  var html = '';
  d.sources.forEach(function(s){
    var nameHtml = s.repo ? '<a href="https://github.com/' + s.repo + '" target="_blank" rel="noopener">' + s.name + '</a>' : s.name;
    html += '<div class="src"><span>' + nameHtml + '</span>' +
      (s.ok ? '<span class="badge ok">正常 · 抓 ' + s.fetched + ' · 新增 ' + s.added + '</span>' : '<span class="badge bad">失败 · ' + s.error + '</span>') + '</div>';
  });
  document.getElementById('srcList').innerHTML = html;
}).catch(function(){
  document.getElementById('upd').textContent = '状态加载失败，请刷新';
});
</script>
</body>
</html>`;
