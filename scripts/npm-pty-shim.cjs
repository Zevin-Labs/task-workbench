// 给 npm 子进程伪造 TTY。
// npm 的 otplease（lib/utils/auth.js）只在 process.stdin.isTTY && process.stdout.isTTY
// 时才进入 web 2FA 流程；在 Agent 的非交互 shell 里两者都是管道，npm 会直接抛 EOTP，
// 浏览器永远打不开。这里把 isTTY 补成 true，让 npm 走正常流程；
// 配合 --browser=false，npm 会打印授权 URL 而不是自己等待按键。
'use strict'

for (const stream of [process.stdin, process.stdout, process.stderr]) {
  if (!stream) continue
  try {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true })
  } catch {
    // 已有 isTTY getter 时忽略
  }
}
