// routes/loc.js —— 位置服务（GPS 上报 + 高德 POI / 路径规划）
//
//   · POST /api/loc         手机定位上报（坐标只在内存，不落盘）
//   · GET  /api/loc         取最近一次定位
//   · GET  /api/nav-config  前端嵌地图要的 jsKey / jsSecurityCode
//   · GET  /api/poi         附近搜索（place/around，按距离排序）
//   · GET  /api/route       driving / walking / bicycling / transit 路径规划
//
// 坐标一律 GCJ02（lastLoc.gcjLat/gcjLng 或显式传参）；WGS84 会偏 ~500m。
// 高德 key 来自 config.amap（webKey 走后端 REST，jsKey/jsSecurityCode 给前端）。

'use strict';

const { config } = require('../config');
const { json, log, readBody } = require('../store');

// 最近一次手机定位（内存，重启即清空）
let lastLoc = null;

function amapCfg() { return config.amap || {}; }

// ---- 高德 REST 调用（带超时：高德挂了绝不能让进程卡住）----
async function amapGet(pathname, params, timeoutMs) {
  const cfg = amapCfg();
  if (!cfg.webKey) throw new Error('未配置高德 Web 服务 key（config.json 的 amap.webKey）');
  const qs = new URLSearchParams(params || {});
  qs.set('key', cfg.webKey);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs || 6000);
  try {
    const r = await fetch('https://restapi.amap.com' + pathname + '?' + qs.toString(), { signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(to); }
}

// ---- 简单缓存（免费额度有限：同一查询 N 秒内复用）----
const _amapCache = new Map();
function cacheGet(k, ttlMs) {
  const e = _amapCache.get(k);
  if (e && Date.now() - e.ts < ttlMs) return e.v;
  return undefined;
}
function cacheSet(k, v) {
  _amapCache.set(k, { ts: Date.now(), v });
  if (_amapCache.size > 400) {
    const cut = Date.now() - 10 * 60000;
    for (const [kk, ee] of _amapCache) if (ee.ts < cut) _amapCache.delete(kk);
  }
  return v;
}

function num(v) { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }
function ll(s) { const a = String(s).split(',').map(Number); return { lng: a[0], lat: a[1] }; }
function fmtM(v) { const n = num(v); if (n == null) return ''; return n >= 1000 ? (n / 1000).toFixed(1) + ' 公里' : Math.round(n) + ' 米'; }
function polyToArr(s, out) {
  if (!s) return;
  for (const seg of String(s).split(';')) {
    const p = seg.split(',');
    if (p.length === 2) {
      const lng = Number(p[0]), lat = Number(p[1]);
      if (isFinite(lng) && isFinite(lat)) out.push([lng, lat]);
    }
  }
}

// ---- 城市码（公交规划要 city/cityd）—— regeo 取 citycode，按粗坐标缓存 ----
async function amapCityCode(lng, lat) {
  const k = 'city:' + lng.toFixed(2) + ',' + lat.toFixed(2);
  let v = cacheGet(k, 30 * 60000);
  if (v !== undefined) return v;
  try {
    const j = await amapGet('/v3/geocode/regeo', { location: lng.toFixed(6) + ',' + lat.toFixed(6) });
    v = (j.regeocode && j.regeocode.addressComponent && j.regeocode.addressComponent.citycode) || '';
  } catch (e) { v = ''; }
  return cacheSet(k, v);
}

// ---- 路径规划结果整形（driving/walking/bicycling 通用：paths[0]）----
function buildRoute(paths, mode, oStr, dStr) {
  const p = paths && paths[0];
  if (!p) return { ok: false, error: '没有规划出路线（可能太近，或该方式不支持这段路）' };
  const steps = (p.steps || []).map((s) => ({
    instruction: s.instruction || '',
    road: (s.road && s.road !== '[]') ? s.road : '',
    distance: num(s.distance), duration: num(s.duration), kind: mode,
  }));
  const poly = [];
  for (const s of (p.steps || [])) polyToArr(s.polyline, poly);
  return {
    ok: true, mode, distance: num(p.distance), duration: num(p.duration),
    cost: null, strategy: p.strategy || '', from: ll(oStr), to: ll(dStr),
    steps, polyline: poly,
  };
}

// ---- 公交整形（transit：分段 = 步行 + 线路）----
function buildTransit(j, city, cityd, oStr, dStr) {
  if (j.status !== '1') return { ok: false, error: '高德返回：' + (j.info || j.status) };
  const r = j.route || {};
  const t = (r.transits || [])[0];
  if (!t) return { ok: false, error: '没有公交方案（这段路可能太近，试试步行）' };
  const steps = [], poly = [];
  for (const seg of (t.segments || [])) {
    if (seg.walking && num(seg.walking.distance) > 0) {
      steps.push({ instruction: '步行 ' + fmtM(seg.walking.distance), distance: num(seg.walking.distance), duration: num(seg.walking.duration), kind: 'walk' });
      for (const ws of (seg.walking.steps || [])) polyToArr(ws.polyline, poly);
    }
    if (seg.bus && seg.bus.buslines) {
      for (const bl of seg.bus.buslines) {
        const dep = (bl.departure_stop && bl.departure_stop.name) ? bl.departure_stop.name : '';
        const arr = (bl.arrival_stop && bl.arrival_stop.name) ? bl.arrival_stop.name : '';
        steps.push({
          instruction: '乘 ' + (bl.name || '公交') + (dep ? ('（' + dep + ' → ' + arr + '）') : '') + (bl.via_num ? ('，' + bl.via_num + ' 站') : ''),
          distance: num(bl.distance), duration: num(bl.duration), kind: 'bus',
        });
        polyToArr(bl.polyline, poly);
      }
    }
  }
  return {
    ok: true, mode: 'transit', distance: num(r.distance), duration: num(t.duration),
    cost: num(t.cost), walking: num(t.walking_distance), strategy: '',
    city: city, cityd: cityd, from: ll(oStr), to: ll(dStr), steps, polyline: poly,
  };
}

async function handle(req, res, url, p) {
  if (p === '/api/loc' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}');
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!isFinite(lat) || !isFinite(lng)) return json(res, 400, { ok: false, error: '没有有效坐标' }), true;
    lastLoc = {
      lat: lat, lng: lng,
      acc: (b.acc == null || Number(b.acc) < 0) ? null : Number(b.acc),
      provider: String(b.provider || ''),
      ts: Number(b.ts) || Date.now(),
      receivedAt: Date.now(),
      src: String(b.src || 'phone'),
      gcjLat: isFinite(Number(b.gcjLat)) ? Number(b.gcjLat) : null,
      gcjLng: isFinite(Number(b.gcjLng)) ? Number(b.gcjLng) : null,
    };
    log(`📍 收到定位 ${lat.toFixed(6)},${lng.toFixed(6)} ±${lastLoc.acc == null ? '?' : Math.round(lastLoc.acc)}m (${lastLoc.provider})`);
    return json(res, 200, { ok: true }), true;
  }
  if (p === '/api/loc' && req.method === 'GET') {
    return json(res, 200, { ok: true, loc: lastLoc }), true;
  }

  if (p === '/api/nav-config' && req.method === 'GET') {
    const c = amapCfg();
    return json(res, 200, { ok: true, jsKey: c.jsKey || '', jsSecurityCode: c.jsSecurityCode || '' }), true;
  }

  if (p === '/api/poi' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    let lat = num(url.searchParams.get('lat')), lng = num(url.searchParams.get('lng'));
    if ((lat == null || lng == null) && lastLoc && lastLoc.gcjLat != null) { lat = lastLoc.gcjLat; lng = lastLoc.gcjLng; }
    if (!q) { json(res, 400, { ok: false, error: '缺 q（搜什么，例如 q=味千）' }); return true; }
    if (lat == null || lng == null) {
      json(res, 200, { ok: false, needLoc: true, error: '还没收到手机位置（先在页面里定位一次，或传 ?lat=&lng=）' });
      return true;
    }
    const radius = Math.min(50000, Math.max(200, num(url.searchParams.get('radius')) || 50000));
    const limit = Math.min(25, Math.max(1, num(url.searchParams.get('limit')) || 10));
    const locStr = lng.toFixed(6) + ',' + lat.toFixed(6);
    const ck = 'poi:' + locStr + ':' + radius + ':' + limit + ':' + q;
    const hit = cacheGet(ck, 60 * 1000);
    if (hit) { json(res, 200, hit); return true; }
    try {
      const j = await amapGet('/v3/place/around', {
        location: locStr, keywords: q, radius: String(radius),
        offset: String(limit), page: '1', extensions: 'base',
      });
      if (j.status !== '1') { json(res, 200, { ok: false, error: '高德返回：' + (j.info || j.status) }); return true; }
      const pois = (j.pois || []).filter((o) => o && o.location).map((o) => {
        const a = String(o.location).split(',').map(Number);
        return {
          id: o.id, name: o.name,
          address: (o.address && o.address !== '[]') ? o.address : '',
          tel: (o.tel && o.tel !== '[]') ? o.tel : '',
          distance: num(o.distance), lng: a[0], lat: a[1],
          type: o.type || '',
          city: (o.cityname && o.cityname !== '[]') ? o.cityname : '',
          adname: (o.adname && o.adname !== '[]') ? o.adname : '',
        };
      }).sort((x, y) => (x.distance == null ? 1e9 : x.distance) - (y.distance == null ? 1e9 : y.distance));
      const out = { ok: true, q, center: { lat, lng }, count: pois.length, pois };
      log('🧭 POI「' + q + '」附近 ' + pois.length + ' 条 @ ' + locStr);
      json(res, 200, cacheSet(ck, out));
      return true;
    } catch (e) {
      json(res, 200, { ok: false, error: '高德请求失败：' + e.message });
      return true;
    }
  }

  if (p === '/api/route' && req.method === 'GET') {
    const mode = (url.searchParams.get('mode') || 'driving').trim();
    if (['driving', 'walking', 'bicycling', 'transit'].indexOf(mode) < 0) {
      json(res, 400, { ok: false, error: 'mode 只能是 driving/walking/bicycling/transit' });
      return true;
    }
    let flat = num(url.searchParams.get('flat')), flng = num(url.searchParams.get('flng'));
    let tlat = num(url.searchParams.get('tlat')), tlng = num(url.searchParams.get('tlng'));
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if ((flat == null || flng == null) && from) { const a = from.split(',').map(Number); if (a.length === 2) { flat = a[0]; flng = a[1]; } }
    if ((tlat == null || tlng == null) && to) { const a = to.split(',').map(Number); if (a.length === 2) { tlat = a[0]; tlng = a[1]; } }
    if ([flat, flng, tlat, tlng].some((v) => v == null)) {
      json(res, 400, { ok: false, error: '缺坐标（flat/flng/tlat/tlng，或 from/to = "lat,lng"）' });
      return true;
    }
    const oStr = flng.toFixed(6) + ',' + flat.toFixed(6);
    const dStr = tlng.toFixed(6) + ',' + tlat.toFixed(6);
    const ck = 'route:' + mode + ':' + oStr + ':' + dStr;
    const hit = cacheGet(ck, 120 * 1000);
    if (hit) { json(res, 200, hit); return true; }
    try {
      let out = null;
      if (mode === 'driving') {
        const j = await amapGet('/v3/direction/driving', { origin: oStr, destination: dStr, extensions: 'base', strategy: '0' });
        out = (j.status !== '1') ? { ok: false, error: '高德返回：' + (j.info || j.status) } : buildRoute(j.route && j.route.paths, mode, oStr, dStr);
      } else if (mode === 'walking') {
        const j = await amapGet('/v3/direction/walking', { origin: oStr, destination: dStr });
        out = (j.status !== '1') ? { ok: false, error: '高德返回：' + (j.info || j.status) } : buildRoute(j.route && j.route.paths, mode, oStr, dStr);
      } else if (mode === 'bicycling') {
        const j = await amapGet('/v4/direction/bicycling', { origin: oStr, destination: dStr });
        out = (j.errcode !== 0) ? { ok: false, error: '高德返回：' + (j.errmsg || j.errcode) } : buildRoute(j.data && j.data.paths, mode, oStr, dStr);
      } else {
        let city = url.searchParams.get('city') || '';
        let cityd = url.searchParams.get('cityd') || '';
        if (!city) city = await amapCityCode(flng, flat);
        if (!cityd) cityd = await amapCityCode(tlng, tlat);
        const j = await amapGet('/v3/direction/transit/integrated', {
          origin: oStr, destination: dStr, city: city, cityd: cityd, strategy: '0', extensions: 'all',
        });
        out = buildTransit(j, city, cityd, oStr, dStr);
      }
      if (out && out.ok) log('🧭 路线 ' + mode + ' ' + out.distance + 'm/' + out.duration + 's → ' + oStr + ' ~ ' + dStr);
      json(res, 200, (out && out.ok) ? cacheSet(ck, out) : out);
      return true;
    } catch (e) {
      json(res, 200, { ok: false, error: '高德请求失败：' + e.message });
      return true;
    }
  }

  return false;
}

function register(server, config) {
  server.addRoute(handle);
}

module.exports = { register };
