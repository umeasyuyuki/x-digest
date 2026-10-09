// データの置き場と読み書き。
//
// 置き場をリポジトリ外（既定 ~/Library/Application Support/x-digest/）にしているのは
// 規約整合ではなく安全性の理由: profile/ には生きた X セッションの資格情報が入るため、
// .gitignore の1行ミスで漏れる場所に置かない。
//
// ストアは追記専用。ブックマークはツイートID順ではなく「ブックマークした時刻」順に返るので、
// 3年前の投稿を今日ブックマークすることが普通にある。ID の水位マークで足切りすると
// そういう投稿を永久に取りこぼす。だから水位ではなく ID 集合で差分を取る。
// 副産物として、途中で失敗しても進めてはいけないカーソルが存在せず、冪等に安全になる。

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from 'node:fs'

const DEFAULT_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'x-digest')
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** データ置き場。X_DIGEST_DATA_DIR で差し替え可能（コードに絶対パスを埋めない）。 */
export function resolveDataDir() {
  const configured = process.env.X_DIGEST_DATA_DIR?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_DATA_DIR
}

export function paths(dataDir = resolveDataDir()) {
  return Object.freeze({
    dataDir,
    profile: join(dataDir, 'profile'),
    raw: join(dataDir, 'raw'),
    bookmarks: join(dataDir, 'bookmarks.jsonl'),
    digests: join(dataDir, 'digests'),
    state: join(dataDir, 'state'),
    lastError: join(dataDir, 'state', 'last-error.txt'),
    lastSuccess: join(dataDir, 'state', 'last-success.txt'),
  })
}

/** ローカル日付の YYYY-MM-DD。ファイル名と first_seen に使う。 */
export function todayStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** データ置き場を 700 で用意する。資格情報が入るので他ユーザーから読めないようにする。 */
export function ensureDirs(p = paths()) {
  for (const dir of [p.dataDir, p.profile, p.raw, p.digests, p.state]) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  }
  return p
}

/** 既知のツイートID集合。差分判定の土台。 */
export function loadKnownIds(p = paths()) {
  if (!existsSync(p.bookmarks)) return new Set()

  const ids = new Set()
  for (const line of readFileSync(p.bookmarks, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const id = JSON.parse(line)?.id
      if (id) ids.add(String(id))
    } catch {
      // 壊れた1行で全体を落とさない。追記専用なので後続行は健全なことが多い。
    }
  }
  return ids
}

/** 蓄積済みの全レコードを読む（ダイジェストの窓を切るときに使う）。 */
export function loadBookmarks(p = paths()) {
  if (!existsSync(p.bookmarks)) return []

  return readFileSync(p.bookmarks, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 未知のものだけを追記する。戻り値は実際に書いた件数。 */
export function appendBookmarks(items, knownIds, p = paths(), stamp = todayStamp()) {
  const fresh = items.filter((item) => !knownIds.has(item.id))
  if (fresh.length === 0) return 0

  const lines = fresh.map((item) => JSON.stringify({ ...item, first_seen: stamp })).join('\n')
  appendFileSync(p.bookmarks, `${lines}\n`, { mode: FILE_MODE })
  for (const item of fresh) knownIds.add(item.id)

  return fresh.length
}

/**
 * 傍受した生レスポンスを gzip でそのまま保存する。
 * これが真実の正本。パーサが壊れても、修正版で過去分を再パースできる。
 */
export function saveRawResponse(response, index, p = paths(), stamp = todayStamp()) {
  const dir = join(p.raw, stamp)
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })

  const file = join(dir, `${String(index).padStart(3, '0')}.json.gz`)
  writeFileSync(file, gzipSync(JSON.stringify(response)), { mode: FILE_MODE })
  return file
}

/** 一時ファイルに書いてから rename する。失敗時に last-known-good を壊さない。 */
export function atomicWrite(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true, mode: DIR_MODE })

  const tmp = `${targetPath}.tmp`
  writeFileSync(tmp, content, { mode: FILE_MODE })
  renameSync(tmp, targetPath)
}

/** エラーはコードと時刻だけ残す。本文もトークンも書かない（sync.sh の既存規範）。 */
export function recordError(code, label, p = paths()) {
  ensureDirs(p)
  writeFileSync(p.lastError, `${new Date().toISOString()} rc=${code} ${label}\n`, { mode: FILE_MODE })
}

export function recordSuccess(summary, p = paths()) {
  ensureDirs(p)
  writeFileSync(p.lastSuccess, `${new Date().toISOString()} ${summary}\n`, { mode: FILE_MODE })
  if (existsSync(p.lastError)) writeFileSync(p.lastError, '', { mode: FILE_MODE })
}
