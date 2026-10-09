// parse-bookmarks の回帰テスト。
//
// このテストの存在意義: X の GraphQL レスポンス構造は予告なく変わる。傍受そのものは
// operation 名で照合するので queryId のローテーションには耐えるが、構造変化には耐えない。
// 生レスポンスをフィクスチャに固定しておけば、壊れたときにどこが変わったかが即座に分かる。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseBookmarksResponse, hasAuthError, toIsoDate } from '../src/parse-bookmarks.mjs'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/bookmarks-page.json', import.meta.url)), 'utf8'),
)

test('通常のツイートを id / author / text / url / created_at に正規化する', () => {
  const { items } = parseBookmarksResponse(fixture)
  const tweet = items.find((i) => i.id === '1000000000000000001')

  assert.equal(tweet.author, '@alice_dev')
  assert.equal(tweet.text, '普通のツイート https://t.co/abcd')
  assert.equal(tweet.url, 'https://x.com/alice_dev/status/1000000000000000001')
  assert.equal(tweet.created_at, '2026-08-27T14:03:00.000Z')
})

test('TweetWithVisibilityResults のラッパーを1段剥がす', () => {
  const { items } = parseBookmarksResponse(fixture)
  const tweet = items.find((i) => i.id === '1000000000000000002')

  assert.equal(tweet.author, '@bob_ml')
  assert.equal(tweet.text, '可視性ラッパー付きのツイート')
})

test('note_tweet があれば切り詰められた full_text ではなく全文を採用する', () => {
  const { items } = parseBookmarksResponse(fixture)
  const tweet = items.find((i) => i.id === '1000000000000000003')

  assert.equal(tweet.text, '長文ツイートの全文。note_tweet がある場合はこちらを優先する。')
})

test('削除済みツイート (TweetTombstone) を除外する', () => {
  const { items } = parseBookmarksResponse(fixture)
  assert.equal(items.some((i) => i.id === '1000000000000000004'), false)
})

test('カーソルエントリを item として取り込まず、cursor として返す', () => {
  const { items, cursor } = parseBookmarksResponse(fixture)

  assert.equal(items.length, 3)
  assert.equal(cursor, 'DAABCgABExample')
})

test('tweetEntryCount はツイート形のエントリ数を数える（パーサ破損の検出に使う）', () => {
  const { tweetEntryCount } = parseBookmarksResponse(fixture)
  // tombstone を含む 4 件。正規化できたのは 3 件。
  assert.equal(tweetEntryCount, 4)
})

test('空のレスポンスで例外を投げず、空の結果を返す', () => {
  const result = parseBookmarksResponse({})

  assert.deepEqual(result.items, [])
  assert.equal(result.tweetEntryCount, 0)
  assert.equal(result.cursor, null)
})

test('instructions が想定外の形でも壊れない', () => {
  const broken = { data: { bookmark_timeline_v2: { timeline: { instructions: 'not-an-array' } } } }
  assert.deepEqual(parseBookmarksResponse(broken).items, [])
})

test('hasAuthError は code 32 (Could not authenticate you) を検出する', () => {
  assert.equal(hasAuthError({ errors: [{ code: 32, message: 'Could not authenticate you' }] }), true)
  assert.equal(hasAuthError({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }), false)
  assert.equal(hasAuthError({ data: {} }), false)
})

test('toIsoDate は Twitter 形式を ISO 8601 に変換し、壊れた入力では null を返す', () => {
  assert.equal(toIsoDate('Wed Aug 27 14:03:00 +0000 2026'), '2026-08-27T14:03:00.000Z')
  assert.equal(toIsoDate('nonsense'), null)
  assert.equal(toIsoDate(undefined), null)
})
