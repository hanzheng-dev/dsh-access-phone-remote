/*
 * Http —— 原生 HTTP 请求小工具（对齐安卓 MainActivity / FileReceiver 里的 HttpURLConnection 用法）。
 *
 * 用 @ohos.net.http。
 * 文档：https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http
 *
 * 说明：
 *   · 原生请求没有 WebView 的 Cookie，必须自带 X-Auth 头（同安卓）。
 *   · 复杂 JSON 的解析交给调用方（用 JSON.parse）。
 */
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';

export interface HttpResult {
  code: number;
  body: string;
}

/** 把多个 Uint8Array 拼成一个 ArrayBuffer（手写 multipart 用）。 */
export function concatBytes(parts: Uint8Array[]): ArrayBuffer {
  let total: number = 0;
  for (let i = 0; i < parts.length; i++) {
    total += parts[i].length;
  }
  const out: Uint8Array = new Uint8Array(total);
  let off: number = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], off);
    off += parts[i].length;
  }
  return out.buffer;
}

/** UTF-8 字符串 → Uint8Array（等价于安卓 getBytes("UTF-8")）。 */
export function utf8(s: string): Uint8Array {
  const enc: util.TextEncoder = new util.TextEncoder();
  return enc.encodeInto(s);
}

/** POST JSON，返回响应码与响应体文本。 */
export async function postJson(url: string, auth: string, jsonBody: string,
                               connectMs: number, readMs: number): Promise<HttpResult> {
  const req: http.HttpRequest = http.createHttp();
  try {
    const resp: http.HttpResponse = await req.request(url, {
      method: http.RequestMethod.POST,
      header: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Auth': auth
      },
      extraData: jsonBody,
      connectTimeout: connectMs,
      readTimeout: readMs,
      expectDataType: http.HttpDataType.STRING
    });
    const body: string = typeof resp.result === 'string' ? resp.result as string : '';
    return { code: resp.responseCode, body: body };
  } finally {
    req.destroy();
  }
}

/** GET，返回响应码与响应体文本。 */
export async function getText(url: string, auth: string,
                              connectMs: number, readMs: number): Promise<HttpResult> {
  const req: http.HttpRequest = http.createHttp();
  try {
    const resp: http.HttpResponse = await req.request(url, {
      method: http.RequestMethod.GET,
      header: {
        'Accept': 'application/json',
        'X-Auth': auth
      },
      connectTimeout: connectMs,
      readTimeout: readMs,
      expectDataType: http.HttpDataType.STRING
    });
    const body: string = typeof resp.result === 'string' ? resp.result as string : '';
    return { code: resp.responseCode, body: body };
  } finally {
    req.destroy();
  }
}

/**
 * 手写 multipart 上传单文件（与 hub-server.js 的 /api/upload 解析方式一致：单文件）。
 * 返回服务端回的 url（失败返回空串）。
 */
export async function uploadBytes(base: string, auth: string, data: ArrayBuffer,
                                  fname: string, mime: string): Promise<string> {
  const bnd: string = '----dsjiang' + Date.now().toString();
  const prefix: string = '--' + bnd + '\r\n'
    + 'Content-Disposition: form-data; name="file"; filename="' + fname + '"\r\n'
    + 'Content-Type: ' + mime + '\r\n\r\n';
  const suffix: string = '\r\n--' + bnd + '--\r\n';
  const body: ArrayBuffer = concatBytes([utf8(prefix), new Uint8Array(data), utf8(suffix)]);

  const req: http.HttpRequest = http.createHttp();
  try {
    const resp: http.HttpResponse = await req.request(base + '/api/upload', {
      method: http.RequestMethod.POST,
      header: {
        'Content-Type': 'multipart/form-data; boundary=' + bnd,
        'X-Auth': auth
      },
      extraData: body,
      connectTimeout: 15000,
      readTimeout: 90000,
      expectDataType: http.HttpDataType.STRING
    });
    if (resp.responseCode !== 200) {
      return '';
    }
    const txt: string = typeof resp.result === 'string' ? resp.result as string : '';
    const obj: Record<string, Object> = JSON.parse(txt) as Record<string, Object>;
    const okb: boolean = obj.ok as boolean;
    if (!okb) {
      return '';
    }
    const u: Object | undefined = obj.url;
    return typeof u === 'string' ? u as string : '';
  } finally {
    req.destroy();
  }
}
