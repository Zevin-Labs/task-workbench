#!/usr/bin/env node
/**
 * 在非交互（无 TTY）环境运行 npm 写操作，并把 npm 的 web 2FA 授权链接交给系统浏览器。
 *
 * 背景：npm 的 otplease 只有在 stdin/stdout 都是 TTY 时才走 web 2FA：
 *   - 非 TTY：直接抛 EOTP，浏览器不会打开；
 *   - TTY：打印授权 URL，等用户按 ENTER 后 `open` 浏览器，同时在后台轮询 doneUrl。
 * Agent 的 shell 是非 TTY，因此 publish 永远卡在 EOTP。本脚本：
 *   1. 用 node --require scripts/npm-pty-shim.cjs 启动 npm，补齐 isTTY；
 *   2. 传 --browser=false，让 npm 只打印 URL、不等待按键（避免再次需要 TTY 输入）；
 *   3. 解析打印出的授权 URL，用系统 open 打开浏览器；npm 自己轮询授权结果并继续执行。
 *
 * 用法：
 *   node scripts/npm-publish-web.mjs publish
 *   node scripts/npm-publish-web.mjs dist-tag add dsh-task-workbench@0.6.2 latest
 *
 * 参数原样交给 npm；脚本会补上 --browser=false 与工作区内 --cache。
 * 退出码与 npm 子进程一致；未出现授权 URL 且失败时给出排查提示。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHIM = path.join(ROOT, 'scripts', 'npm-pty-shim.cjs')
const CACHE = path.join(ROOT, 'test-tmp', 'npm-cache')
const TIMEOUT_MS = 15 * 60 * 1000
const URL_RE = /https:\/\/[^\s"'<>]*\/auth\/cli\/[A-Za-z0-9._~-]+/

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法：node scripts/npm-publish-web.mjs <npm 子命令> [参数...]')
  process.exit(2)
}

const npmCli = path.join(
  execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
  'npm', 'bin', 'npm-cli.js'
)
if (!existsSync(npmCli)) {
  console.error(`找不到 npm CLI：${npmCli}`)
  process.exit(2)
}
mkdirSync(CACHE, { recursive: true })

const child = spawn(
  process.execPath,
  ['--require', SHIM, npmCli, ...args, '--browser=false', `--cache=${CACHE}`],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_cache: CACHE } }
)

let opened = false
let scanBuf = ''
let allTail = ''
const timeout = setTimeout(() => {
  console.error(`\n[npm-publish-web] 超过 ${TIMEOUT_MS / 60000} 分钟未完成，终止。`)
  child.kill('SIGTERM')
  process.exitCode = 1
}, TIMEOUT_MS)

const forward = (chunk) => {
  process.stdout.write(chunk)
  allTail = (allTail + chunk.toString()).slice(-4000)
  if (opened) return
  // npm 输出可能被拆成多个 chunk，保留尾部窗口再匹配
  scanBuf = (scanBuf + chunk.toString()).slice(-2000)
  const match = scanBuf.match(URL_RE)
  if (!match) return
  const url = match[0]
  opened = true
  console.log(`\n[npm-publish-web] 需要在浏览器完成 npm 2FA 授权：\n${url}\n`)
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const win = spawn(opener, [url], { stdio: 'ignore', detached: true })
  win.on('error', () => console.error('[npm-publish-web] 无法自动打开浏览器，请手动打开上面的链接。'))
  win.unref()
}

child.stdout.on('data', forward)
child.stderr.on('data', forward)

child.on('close', (code) => {
  clearTimeout(timeout)
  if (code !== 0 && !opened && /\b(EOTP|ENEEDAUTH|E401)\b/.test(allTail)) {
    console.error('[npm-publish-web] npm 报了认证类错误（EOTP/ENEEDAUTH/E401），但没有给出 2FA 授权链接；先在终端完成 npm login 或检查 token。')
  }
  process.exit(code ?? 1)
})
