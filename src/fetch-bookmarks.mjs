// Stage 1: x.com/i/bookmarks から自分のブックマークを取得して蓄積する。LLM は使わない。
//
// 取得方法は DOM スクレイピングではなく、X 自身の GraphQL レスポンスの傍受。
// リクエストを自作せず「ブラウザが投げたものの応答を横で見る」だけなので、
// URL に埋まる queryId が 2〜4 週ごとに変わっても影響を受けない（照合は operation 名で行う）。
//
// ブラウザは playwright-core + バンドルの chromium。システムの Google Chrome を使わないのは、
// あちらが自動更新で黙って上がり、CDP のズレで無人ジョブがサイレントに壊れるため。

import { chromium } from 'playwright-core'

import { parseBookmarksResponse, hasAuthError } from './parse-bookmarks.mjs'
import {
  paths,
  ensureDirs,
  loadKnownIds,
  appendBookmarks,
  saveRawResponse,
  recordError,
  recordSuccess,
  todayStamp,
} from './store.mjs'

const BOOKMARKS_URL = 'https://x.com/i/bookmarks'
const BOOKMARKS_PATH = '/i/bookmarks'
// 初回ログインはログイン画面へ直接飛ばす。/i/bookmarks から入るとオンボーディングの
// リダイレクトを一段挟むことになり、手作業の導線が分かりにくくなる。
const LOGIN_URL = 'https://x.com/login'
const GRAPHQL_MARKER = '/i/api/graphql/'
const OPERATION_PATTERN = /\/Bookmarks(\?|$)/

// 実物の Chrome と同じ UA を名乗る。新ヘッドレスでも UA に Headless が残る場合があるため明示する。
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

// X のログインセッションの実体。これが揃っていなければログインは完了していない。
// （ページ訪問だけでも guest 系の Cookie は増えるので、件数では判定できない）
const REQUIRED_COOKIES = ['auth_token', 'ct0']

const DEFAULT_MAX_PAGES = 20
const IDLE_ROUNDS_BEFORE_STOP = 2
const HARD_DEADLINE_MS = 120_000
const NAV_TIMEOUT_MS = 45_000
const FIRST_RESPONSE_WAIT_MS = 5_000
const LOGIN_WAIT_MS = 300_000
const SCROLL_MIN_MS = 1_500
const SCROLL_MAX_MS = 4_000

// 故障の分類。呼び出し側（fetch.sh）がこのコードで挙動を変える。
export const EXIT = Object.freeze({
  OK: 0,
  NO_RESPONSE: 2, // GraphQL が1件も来ない = ネットワーク/レンダリング失敗
  LOGIN_EXPIRED: 3, // 人間の介入（再ログイン）が要る唯一のケース
  PARSER_BROKEN: 4, // entry はあるのに正規化できない = X の構造変更
  UNEXPECTED: 5,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * ブックマークページに留まれているか。
 * 未ログインだと X は /i/jf/onboarding/web?...&mode=login など複数の入口に飛ばすので、
 * 特定のログインURLを列挙するのではなく「目的のページに居ないこと」で判定する。
 */
export const isOnBookmarksPage = (url) => {
  try {
    return new URL(url).pathname.startsWith(BOOKMARKS_PATH)
  } catch {
    return false
  }
}

/** スクロール間隔にゆらぎを入れる。等間隔のアクセスは機械的な信号になる。 */
const jitteredDelay = () => SCROLL_MIN_MS + Math.random() * (SCROLL_MAX_MS - SCROLL_MIN_MS)

function parseArgs(argv) {
  const maxPagesIndex = argv.indexOf('--max-pages')
  const maxPages =
    maxPagesIndex >= 0 ? Number.parseInt(argv[maxPagesIndex + 1], 10) : Number.NaN

  return {
    headed: argv.includes('--headed'),
    login: argv.includes('--login'),
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : DEFAULT_MAX_PAGES,
  }
}

async function openContext({ headed, profileDir }) {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', // headless_shell ではなくフルの chromium を新ヘッドレスで使う
    headless: !headed,
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  })
}

/**
 * 初回ログイン用。ヘッドフルでブラウザを開き、ユーザーが手動でログインするのを待つ。
 * 資格情報はプロファイルに焼き付き、以降のヘッドレス実行で再利用される。
 */
async function runLogin(profileDir) {
  const context = await openContext({ headed: true, profileDir })
  const page = context.pages()[0] ?? (await context.newPage())

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })

  process.stdout.write(
    'このウィンドウは普段の Chrome とは別のブラウザです。ここで X にログインしてください。\n' +
      'ログイン後、自動でブックマーク一覧に移動します。表示されるまで閉じないでください（最大5分）。\n',
  )

  // ログインが済んだらブックマークへ誘導する。ここに到達できることが成功の定義。
  page
    .waitForURL((url) => url.pathname === '/home', { timeout: LOGIN_WAIT_MS })
    .then(() => page.goto(BOOKMARKS_URL, { waitUntil: 'domcontentloaded' }))
    .catch(() => {}) // 直接ブックマークに飛ぶ経路もあるので、失敗しても下の待機に任せる

  try {
    await page.waitForURL((url) => url.pathname.startsWith(BOOKMARKS_PATH), {
      timeout: LOGIN_WAIT_MS,
    })
  } catch {
    await context.close()
    process.stderr.write('ブックマーク一覧に到達しないまま時間切れになりました。\n')
    return EXIT.LOGIN_EXPIRED
  }

  await page.waitForTimeout(3_000)

  // セッション Cookie が実際に入ったかを確認してから成功と言う。
  // 「保存しました」と言っておいて翌朝の自動実行が rc=3 で落ちるのが最悪なので、ここで確定させる。
  const cookieNames = new Set((await context.cookies()).map((cookie) => cookie.name))
  await context.close()

  const missing = REQUIRED_COOKIES.filter((name) => !cookieNames.has(name))
  if (missing.length > 0) {
    process.stderr.write(
      `ログインは完了していません（セッション Cookie ${missing.join(', ')} が入っていません）。\n` +
        'もう一度実行し、ブックマーク一覧が表示されるまでウィンドウを閉じないでください。\n',
    )
    return EXIT.LOGIN_EXPIRED
  }

  process.stdout.write('ログイン情報をプロファイルに保存しました。\n')
  return EXIT.OK
}

/**
 * ブックマークを取得する。
 * 傍受したレスポンスは即座に生のまま保存し、正規化はメモリ上で行う。
 */
async function runFetch({ headed, maxPages }) {
  const p = ensureDirs(paths())
  const stamp = todayStamp()
  const knownIds = loadKnownIds(p)

  const context = await openContext({ headed, profileDir: p.profile })
  const page = context.pages()[0] ?? (await context.newPage())

  const stats = { responses: 0, tweetEntries: 0, parsed: 0, appended: 0, authError: false }

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes(GRAPHQL_MARKER) || !OPERATION_PATTERN.test(url)) return

    let json
    try {
      json = await response.json()
    } catch {
      return // 本文が読めないレスポンスは無視する（リダイレクト等）
    }

    stats.responses += 1
    saveRawResponse(json, stats.responses, p, stamp)

    if (hasAuthError(json)) {
      stats.authError = true
      return
    }

    const { items, tweetEntryCount } = parseBookmarksResponse(json)
    stats.tweetEntries += tweetEntryCount
    stats.parsed += items.length
    stats.appended += appendBookmarks(items, knownIds, p, stamp)
  })

  try {
    await page.goto(BOOKMARKS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForTimeout(FIRST_RESPONSE_WAIT_MS)

    if (!isOnBookmarksPage(page.url())) {
      stats.authError = true // ログイン画面に飛ばされた
    } else {
      await scrollUntilExhausted(page, stats, maxPages)
    }
  } finally {
    await context.close()
  }

  return stats
}

/** 新規が出なくなるまでスクロールする。上限とデッドラインで必ず止まる。 */
async function scrollUntilExhausted(page, stats, maxPages) {
  const deadline = Date.now() + HARD_DEADLINE_MS
  let idleRounds = 0

  for (let round = 0; round < maxPages; round += 1) {
    if (Date.now() > deadline || idleRounds >= IDLE_ROUNDS_BEFORE_STOP || stats.authError) break

    const appendedBefore = stats.appended
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(jitteredDelay())

    idleRounds = stats.appended === appendedBefore ? idleRounds + 1 : 0
  }
}

/** 統計から故障を分類する。「新着なし」と「壊れている」を取り違えないための要。 */
export function classify(stats) {
  if (stats.authError) return EXIT.LOGIN_EXPIRED
  if (stats.responses === 0) return EXIT.NO_RESPONSE
  if (stats.tweetEntries > 0 && stats.parsed === 0) return EXIT.PARSER_BROKEN
  return EXIT.OK
}

const EXIT_LABELS = {
  [EXIT.NO_RESPONSE]: 'GraphQL レスポンスを1件も受信できなかった',
  [EXIT.LOGIN_EXPIRED]: 'X のログインが切れている（npm run login の再実行が必要）',
  [EXIT.PARSER_BROKEN]: 'entry はあるが正規化できない（X の構造変更の可能性）',
  [EXIT.UNEXPECTED]: '想定外のエラー',
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.login) {
    return runLogin(ensureDirs(paths()).profile)
  }

  const stats = await runFetch(args)
  const code = classify(stats)

  if (code === EXIT.OK) {
    const summary = `responses=${stats.responses} parsed=${stats.parsed} appended=${stats.appended}`
    recordSuccess(summary)
    process.stdout.write(`${summary}\n`)
  } else {
    recordError(code, EXIT_LABELS[code])
    process.stderr.write(`${EXIT_LABELS[code]}\n`)
  }

  return code
}

// テストから import しただけでブラウザが起動しないよう、直接実行時だけ走らせる。
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      // 本文は残さない。名前と時刻だけ（sync.sh の既存規範）。
      recordError(EXIT.UNEXPECTED, error?.name ?? 'Error')
      process.stderr.write(`${error?.name ?? 'Error'}: ${error?.message ?? ''}\n`)
      process.exit(EXIT.UNEXPECTED)
    })
}
