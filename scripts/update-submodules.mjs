#!/usr/bin/env node
//
// update-submodules.mjs — 把 git submodule 拉到远端跟踪分支最新提交，并递归同步嵌套子模块
//
// 用法：
//   node scripts/update-submodules.mjs                  # 更新 .gitmodules 中所有顶层 submodule
//   node scripts/update-submodules.mjs <path> [<path>]  # 只更新指定路径
//   node scripts/update-submodules.mjs --no-commit      # 暂存但不 commit
//   node scripts/update-submodules.mjs --no-stage       # 不暂存（蕴含 --no-commit）
//   node scripts/update-submodules.mjs --help
//
// 默认会自动 commit 实际发生变更的 submodule 路径（用 pathspec，不影响其他 staged 改动）。

import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  options: {
    'no-stage': { type: 'boolean', default: false },
    'no-commit': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
})

if (values.help) {
  console.log(
    [
      '用法：',
      '  node scripts/update-submodules.mjs [path...]   默认更新所有顶层 submodule',
      '  node scripts/update-submodules.mjs --no-commit  暂存但不 commit',
      '  node scripts/update-submodules.mjs --no-stage   不暂存（蕴含 --no-commit）',
    ].join('\n'),
  )
  process.exit(0)
}

const noStage = values['no-stage']
const noCommit = values['no-commit'] || noStage

function gitCapture(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'],
    ...opts,
  }).trim()
}

function gitInherit(args, opts = {}) {
  execFileSync('git', args, { stdio: 'inherit', ...opts })
}

function listSubmodulePaths() {
  let out = ''
  try {
    out = gitCapture(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  } catch {
    return []
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => line.split(/\s+/).slice(1).join(' '))
}

function pinnedSha(path) {
  return gitCapture(['rev-parse', `HEAD:${path}`])
}

const targets = positionals.length ? positionals : listSubmodulePaths()
if (targets.length === 0) {
  console.error('没有找到任何 submodule（.gitmodules 为空？）')
  process.exit(1)
}

const updated = []

for (const path of targets) {
  console.log(`\n=== ${path} ===`)
  const before = pinnedSha(path)

  // 1) 把外层子模块更新到远端跟踪分支的最新提交（保留分支，fast-forward）
  gitInherit(['submodule', 'update', '--init', '--remote', '--merge', '--', path])

  // 2) 进入外层 submodule，递归同步它内嵌的 submodule 到外层 HEAD 钉的 SHA。
  //    这一步必须在 submodule 内部执行；如果在父仓库里跑 `--recursive`，由于父仓库
  //    index 还没记录新 SHA，会把刚拉到的外层 SHA 回滚回去。
  gitInherit(['-C', path, 'submodule', 'update', '--init', '--recursive'])

  const after = gitCapture(['-C', path, 'rev-parse', 'HEAD'])
  if (before === after) {
    console.log(`${before.slice(0, 10)}（已是最新）`)
  } else {
    console.log(`${before.slice(0, 10)} → ${after.slice(0, 10)}`)
    updated.push({ path, before, after })
  }

  if (!noStage) {
    gitInherit(['add', '--', path])
  }
}

if (!noCommit && updated.length > 0) {
  const subject =
    updated.length === 1
      ? `chore(submodule): 更新 ${updated[0].path} 到 ${updated[0].after.slice(0, 10)}`
      : `chore(submodules): 更新 ${updated.length} 个 submodule`
  const body = updated
    .map(u => `${u.path}: ${u.before.slice(0, 10)}..${u.after.slice(0, 10)}`)
    .join('\n')
  // 用 pathspec 限定提交范围（git commit 默认 --only 语义），不影响其他 staged 改动
  gitInherit(['commit', '-m', subject, '-m', body, '--', ...updated.map(u => u.path)])
} else if (updated.length === 0) {
  console.log('\n所有 submodule 已是最新，无需 commit。')
}
