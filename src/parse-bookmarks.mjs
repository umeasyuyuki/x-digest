// X の Bookmarks GraphQL レスポンス → 正規化レコード。
//
// このモジュールは純関数だけで構成し、I/O を一切持たない。理由は堅牢性:
// X のレスポンス構造は予告なく変わるため、生 JSON は別途 gzip でそのまま保存しておき、
// 構造が変わってここが壊れても、修正版で過去分を再パースできるようにしている。
// I/O が混ざると、この「後から作り直せる」性質が失われる。

const X_BASE_URL = 'https://x.com'

/** 配列でなければ空配列を返す。X のレスポンスは形が崩れることがある。 */
const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * Twitter 形式の日付 ("Wed Aug 27 14:03:00 +0000 2026") を ISO 8601 に変換する。
 * パースできない場合は例外を投げずに null を返す（1件の日付崩れで取り込み全体を落とさない）。
 */
export function toIsoDate(twitterDate) {
  if (typeof twitterDate !== 'string') return null

  const parsed = new Date(twitterDate)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * 認証切れ（X のエラーコード 32 = Could not authenticate you）かどうか。
 * これだけは人間の介入（再ログイン）が要る故障なので、他のエラーと区別する。
 */
export function hasAuthError(response) {
  return asArray(response?.errors).some((error) => error?.code === 32)
}

/** TweetWithVisibilityResults は本体を .tweet に1段包んでいるので剥がす。 */
const unwrapTweet = (result) =>
  result?.__typename === 'TweetWithVisibilityResults' ? result.tweet : result

/**
 * 著者のスクリーンネームを取り出す。X は core 直下に置く形と
 * core.user_results.result.legacy に置く形の両方を返してくるので、両対応する。
 */
function extractScreenName(tweet) {
  return (
    tweet?.core?.user_results?.result?.legacy?.screen_name ??
    tweet?.core?.user_results?.result?.core?.screen_name ??
    tweet?.core?.screen_name ??
    null
  )
}

/**
 * 本文を取り出す。長文ポストは legacy.full_text が切り詰められており、
 * note_tweet 側に全文が入る。全文があればそちらを優先する。
 */
function extractText(tweet) {
  const noteText = tweet?.note_tweet?.note_tweet_results?.result?.text
  if (typeof noteText === 'string' && noteText.length > 0) return noteText

  const fullText = tweet?.legacy?.full_text
  return typeof fullText === 'string' ? fullText : null
}

/**
 * 1件の tweet_results.result を正規化する。
 * 削除済み（TweetTombstone）や必須項目が欠けたものは null を返して呼び出し側で捨てる。
 */
function normalizeTweet(result) {
  const tweet = unwrapTweet(result)
  if (!tweet || tweet.__typename === 'TweetTombstone') return null

  const id = tweet.rest_id
  const screenName = extractScreenName(tweet)
  const text = extractText(tweet)
  if (!id || !screenName || text === null) return null

  return Object.freeze({
    id: String(id),
    author: `@${screenName}`,
    text,
    url: `${X_BASE_URL}/${screenName}/status/${id}`,
    created_at: toIsoDate(tweet?.legacy?.created_at),
  })
}

/** timeline.instructions から全 entry を平坦に取り出す。 */
function collectEntries(response) {
  const instructions = asArray(response?.data?.bookmark_timeline_v2?.timeline?.instructions)

  return instructions.flatMap((instruction) => asArray(instruction?.entries))
}

/**
 * Bookmarks レスポンスを正規化する。
 *
 * 戻り値の tweetEntryCount は「ツイート形のエントリが何件あったか」で、items.length とは別物。
 * この2つが乖離する（entry はあるのに正規化できていない）状態がパーサ破損のシグナルであり、
 * 「新着なし」と区別するために呼び出し側が使う。
 *
 * cursor は今は使わないが、将来 cursor だけ差し替えて fetch を replay する高速ページングに
 * 移行できるよう記録しておく（記録コストがゼロなので捨てない）。
 */
export function parseBookmarksResponse(response) {
  const entries = collectEntries(response)

  const items = []
  let tweetEntryCount = 0
  let cursor = null

  for (const entry of entries) {
    const content = entry?.content

    if (content?.entryType === 'TimelineTimelineCursor') {
      if (content.cursorType === 'Bottom') cursor = content.value ?? null
      continue
    }

    const tweetResult = content?.itemContent?.tweet_results?.result
    if (!tweetResult) continue

    tweetEntryCount += 1

    const normalized = normalizeTweet(tweetResult)
    if (normalized) items.push(normalized)
  }

  return { items, tweetEntryCount, cursor }
}
