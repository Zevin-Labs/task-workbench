#!/usr/bin/env bash
# 一条命令发版：全量测试 + 打包校验 → 升版本 → 推 GitHub → npm publish → GitHub Release。
# 用法：
#   bash scripts/release.sh                # 交互式：问版本类型、问确认、问 npm token
#   bash scripts/release.sh patch          # 直接指定 patch / minor / major / 1.2.3
#   bash scripts/release.sh patch --yes    # 不再确认（token 仍会问）
#   bash scripts/release.sh --dry-run      # 只打印将要执行的步骤，不改任何东西
#
# 设计前提：仓库根有 package.json，origin 指向 GitHub，npm 账号已登录（2FA 用 Bypass 2FA token）。
# 若 npm 报 EPERM（~/.npm 里有 root 属主文件）：先 sudo chown -R 501:20 ~/.npm。
set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
BUMP=""

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage ;;
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) echo "未知参数：$arg（--help 查看用法）" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }

command -v node >/dev/null 2>&1 || die "找不到 node"
[ -f package.json ] || die "当前目录不是 Node 包根目录"
[ -d .git ] || die "当前目录不是 git 仓库"

PKG_NAME="$(node -p "require('./package.json').name")"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
# https://github.com/OWNER/REPO(.git) / git@github.com:OWNER/REPO.git -> OWNER/REPO
REPO_SLUG="$(printf '%s' "$REMOTE_URL" | sed -E 's#^git@github.com:##; s#^ssh://git@github.com/##; s#^https://github.com/##; s#\.git$##')"
case "$BRANCH" in
  main|master) ;;
  *) die "请在 main/master 上发版（当前分支：$BRANCH）" ;;
esac
[ -z "$(git status --porcelain)" ] || die "工作区不干净，先 commit 或 stash"

say "包：$PKG_NAME"
say "分支：$BRANCH"

if [ -z "$BUMP" ]; then
  read -r -p "版本升法（patch=修 bug / minor=加功能 / major=不兼容 / 或直接输入 1.2.3）：" BUMP
fi
case "$BUMP" in
  patch|minor|major) ;;
  *)
    [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版本格式不对：$BUMP"
    ;;
esac

if [ "$DRY_RUN" != 1 ] && [ "$ASSUME_YES" != 1 ]; then
  read -r -p "将执行：测试 + 打包校验 → 升版本($BUMP) → 推 GitHub → npm publish。确认？[y/N] " ANSWER || die "需要交互确认；非交互环境请加 --yes"
  [[ "$ANSWER" =~ ^[Yy]$ ]] || { echo "已取消"; exit 0; }
fi

say "1/5 测试与打包校验（npm run verify + npm run pack:check）"
run npm run verify
run npm run pack:check

say "2/5 升版本 + 本地提交 + 打 tag"
run npm version "$BUMP" -m "release: v%s"
if [ "$DRY_RUN" = 1 ]; then
  VERSION="<新版本>"
else
  VERSION="$(node -p "require('./package.json').version")"
fi
TAG="v$VERSION"
say "新版本：${VERSION}（tag ${TAG}）"

say "3/5 推 GitHub（$BRANCH + tag）"
run git push origin "$BRANCH" --follow-tags

say "4/5 发布到 npm"
if [ "$DRY_RUN" = 1 ]; then
  echo "   [dry-run] npm publish（会提示粘贴 Bypass 2FA token）"
else
  printf "npm token（Bypass 2FA，粘贴后回车，屏幕不显示）："
  read -r -s NPM_TOKEN || die "没有读到 token（非交互环境无法发布）"
  echo
  [ -n "${NPM_TOKEN:-}" ] || die "token 为空，已停止（GitHub 已推送，版本已升）"
  npm publish --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
  unset NPM_TOKEN
fi

say "5/5 建 GitHub Release（有 gh 时）"
if command -v gh >/dev/null 2>&1; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "   [dry-run] npm pack + gh release create $TAG --generate-notes"
  else
    npm pack >/dev/null
    TGZ="${PKG_NAME}-${VERSION}.tgz"
    if [ -f "$TGZ" ]; then
      gh release create "$TAG" "$TGZ" --repo "$REPO_SLUG" --title "$TAG" --generate-notes
      rm -f "$TGZ"
    else
      gh release create "$TAG" --repo "$REPO_SLUG" --title "$TAG" --generate-notes
    fi
  fi
else
  warn "没装 gh，跳过 GitHub Release（不影响 npm）"
fi

say "完成：$PKG_NAME@$VERSION"
echo "提醒：回 npm tokens 页面把本次用的 token 删掉。"
