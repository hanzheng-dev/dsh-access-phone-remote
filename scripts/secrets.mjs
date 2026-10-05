// 敏感值清单的加载器。
//
// 为什么要有这个文件：
//   发布前检查需要一张「本机特征值」表 —— 口令、内网 IP、私有目录名 —— 才能
//   拦住它们混进公开仓库。但如果把这张表直接写在检查脚本里，脚本本身就成了
//   泄漏源：任何人 clone 下来都能读到你的口令。
//
//   所以规则是：**仓库里只有空模板（secrets.example.json），真实值放本地的
//   .secrets.json，而它被 .gitignore 忽略。**
//
// 找不到本地清单时不会报错，只是跳过这一组检查 —— 让「没配」表现为「跳过」，
// 而不是「假装通过」。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 依次在若干候选位置找 .secrets.json。
 * @param {string} [rootHint] 仓库根目录（可选）
 * @returns {{list: {label: string, value: string}[], path: string|null, ok: boolean}}
 */
export function loadSecrets(rootHint) {
  const candidates = [
    rootHint && join(rootHint, 'scripts', '.secrets.json'),
    join(HERE, '.secrets.json'),
    join(HERE, '..', 'scripts', '.secrets.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      const list = (parsed.secrets || [])
        .filter((s) => s && typeof s.value === 'string' && s.value.length >= 3)
        .map((s) => ({ label: String(s.label || '未命名特征值'), value: s.value }));
      if (list.length) return { list, path: p, ok: true };
    } catch {
      // 文件坏了就当没有 —— 但下面会以 ok:false 报出来
    }
  }
  return { list: [], path: null, ok: false };
}

/**
 * 在文本里找命中的特征值。**只返回 label，绝不返回值本身**，
 * 免得检查日志又变成新的泄漏点。
 * @param {string} text
 * @param {{label: string, value: string}[]} list
 * @returns {string[]} 命中的 label 列表
 */
export function scanText(text, list) {
  const hits = [];
  if (!Array.isArray(list) || !list.length) return hits;
  const lower = String(text == null ? '' : text).toLowerCase();
  for (const s of list) {
    if (!s || typeof s.value !== 'string' || !s.value) continue;
    if (lower.includes(s.value.toLowerCase())) hits.push(s.label);
  }
  return hits;
}
