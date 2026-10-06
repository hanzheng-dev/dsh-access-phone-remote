#!/usr/bin/env node
/**
 * set-identity.mjs —— 把仓库里的作者信息占位符换成你自己的
 *
 * 用法：
 *   node scripts/set-identity.mjs --user <你的GitHub用户名> [--author "名字 <邮箱>"]
 *
 * fork 这个项目的人，第一件事就是跑它：把 GitHub 用户名填进去，
 * package.json 和文档里的占位符会一起换掉。
 *
 * ⚠️ 它只改本地文件，不联网、不上传任何东西。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const user = arg('user')
if (!user) {
  console.error('用法: node scripts/set-identity.mjs --user <GitHub用户名> [--author "名字 <邮箱>"]')
  process.exit(1)
}

const author = arg('author', `${user} <${user}@users.noreply.github.com>`)
const web = `https://github.com/${user}/dsh-access-phone-remote`
const repo = `git+${web}.git`

let n = 0
console.log('把作者信息换成你自己的：')

// ---------- 1. package.json / plugin/package.json ----------
for (const rel of ['package.json', 'plugin/package.json']) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) continue
  let j
  try {
    j = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    console.log(`  ! ${rel} 解析失败，跳过`)
    continue
  }
  j.author = author
  j.repository = { type: 'git', url: repo }
  j.homepage = `${web}#readme`
  j.bugs = { url: `${web}/issues` }
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
  console.log(`  ✓ ${rel}`)
  n++
}

// ---------- 2. 文档里的占位符 ----------
const SKIP = new Set(['.git', 'node_modules', 'build', 'dist', 'logs', 'uploads', 'shots', 'data'])

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { walk(p); continue }
    if (!/\.(md|txt)$/i.test(name)) continue

    let s
    try { s = readFileSync(p, 'utf8') } catch { continue }
    let out = s
    out = out.split('<GitHub 链接>').join(web)
    out = out.split('https://github.com/REPLACE_WITH_USERNAME/dsh-access-phone-remote').join(web)
    if (out !== s) {
      writeFileSync(p, out)
      console.log(`  ✓ ${p.replace(ROOT + '/', '')}`)
      n++
    }
  }
}
walk(ROOT)

console.log(`\n完成，改了 ${n} 个文件。`)
console.log('注意：这只动了本地文件。要发布还需要 git push 和 npm publish。')
