import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import {
  accountOf,
  advise,
  byTurn,
  COUNTDOWN_MARKS,
  decideTtl,
  fit as fitText,
  fmtClock,
  fmtTokens,
  hitRatio,
  isCachingDisabled,
  lifeColor,
  lifeRatio,
  nextToastMark,
  observeTtl,
  positive,
  promptTokens,
  remainingMs,
  rowRatio,
  segments as cacheSegments,
} from './cache'
import type { Account, Advice, CacheEnv, Sample, Ttl } from './cache'
import { bar, DIVIDER, formatDay, formatTime, formatTokens, freshSession, limitParts, partsWidth, resumed, sameWindow, track } from './meter'
import type { Limit, Paint, Part, SessionState, WindowKind } from './meter'

const REFRESH_MS = 2000
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LABEL_COLUMNS = 7 // самая длинная подпись, "context" и "session"; нужна для раскладки столбиком
const VALUE_COLUMNS = 4 // цифра контекста, до "100%"
const BAR_COLUMNS = { min: 10, max: 30 }
const SEGMENT_GAP = 3
const MARKER_COLUMNS = 4 // значок [-] полосы справа
const LEGACY_KEYS = ['limit', 'calibration'] // хранилище версий 0.1.0–0.2.x

// Default — серый из темы терминала, Claude — оранжевый, остальное — цвета консоли Windows
// (схема Campbell) под именами из `color /?`. Имена совпадают с options настроек в plugin.json.
const PALETTE: Record<string, string> = {
  Default: 'gray',
  Claude: '#d97757',
  Black: '#0c0c0c',
  Blue: '#0037da',
  Green: '#13a10e',
  Aqua: '#3a96dd',
  Red: '#c50f1f',
  Purple: '#881798',
  Yellow: '#c19c00',
  White: '#cccccc',
  Gray: '#767676',
  'Light Blue': '#3b78ff',
  'Light Green': '#16c60c',
  'Light Aqua': '#61d6d6',
  'Light Red': '#e74856',
  'Light Purple': '#b4009e',
  'Light Yellow': '#f9f1a5',
  'Bright White': '#f2f2f2',
}

const WINDOW_KINDS: ReadonlyArray<readonly [WindowKind, string]> = [
  ['fiveHour', 'five_hour'],
  ['sevenDay', 'seven_day'],
]

type Limits = Partial<Record<WindowKind, Limit>>

// marked — сколько процентов в конце заполнения выделено цветом сессии; parts — текст справа от бара.
type Segment = { label: string; filled: number; marked: number; parts: Part[] }

let session: SessionState | null = null
let costMark = 0 // стоимость сессии в момент, когда её отметки могли устареть; ответ модели её увеличит
let limits: Limits = {}
let context: SessionContextUsage | null = null
let timer: Timer | null = null
let drawn = ''

function paletteColor(name: unknown, fallback: string): string {
  return PALETTE[String(name ?? fallback)] ?? PALETTE[fallback]!
}

function asLimit(rateLimit: SessionRateLimit | undefined): Limit | undefined {
  return rateLimit && { percent: rateLimit.percentUsed, resetsAt: rateLimit.resetsAt }
}

// Окно, которое уже сбросилось, до следующего чтения считается пустым.
function live(limit: Limit | undefined): Limit | undefined {
  if (limit?.resetsAt !== undefined && Date.parse(limit.resetsAt) <= Date.now()) {
    return { percent: 0 }
  }
  return limit
}

async function save($: EngineInterface): Promise<void> {
  if (session !== null) {
    session.touchedAt = Date.now()
    await $.store.set(`session:${session.id}`, session)
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const [id, usage] = await Promise.all([$.session.id(), $.session.usage()])
  context = usage.context
  const cost = usage.cost?.usd
  let changed = false

  if (session === null || session.id !== id) {
    const saved = (await $.store.get(`session:${id}`)) as SessionState | undefined
    // у отметок до 0.5.0 другая форма, их сессия начинает заново
    session = typeof saved?.windows === 'object' ? resumed(saved) : freshSession(id)
    costMark = cost ?? 0
    if (limits.fiveHour === undefined && limits.sevenDay === undefined) {
      limits = ((await $.store.get('limits')) as Limits | undefined) ?? {}
    }
    changed = true
  }

  // стоимость могла обнулиться уже после отметки (/clear); где хост её не ведёт, каждое чтение считается своим
  costMark = Math.min(costMark, cost ?? costMark)
  const replied = cost === undefined || cost > costMark
  const latest: Limits = {}
  for (const [kind, apiKind] of WINDOW_KINDS) {
    const reading = asLimit(usage.rateLimits.find(rateLimit => rateLimit.kind === apiKind))
    if (reading && track(session, kind, reading, replied)) {
      changed = true
    }
    latest[kind] = reading ?? limits[kind]
  }
  if (JSON.stringify(latest) !== JSON.stringify(limits)) {
    limits = latest
    await $.store.set('limits', limits)
  }
  if (changed) {
    await save($)
  }
}

// Окно лимита и доля сессии в нём; null, пока лимит не читался ни разу (ключ API без подписки).
// Доля считается только по текущему окну: после сброса сессия начинает его с нуля, как и само окно.
function windowFigures(kind: WindowKind): { window: Limit; mine: number } | null {
  const window = live(limits[kind])
  if (session === null || window === undefined) {
    return null
  }
  const tracked = session.windows[kind]
  const inWindow = tracked !== undefined && sameWindow(tracked.resetsAt, window.resetsAt)
  const spent = inWindow ? Math.max(0, tracked.last - tracked.base) : 0
  return { window, mine: Math.min(window.percent, spent) }
}

// Бары context, session и week; session и week — только когда лимит уже читался.
function usageSegments(context: SessionContextUsage): Segment[] {
  // tokens нет до первого ответа в свежей сессии и сразу после compact
  const contextPercent = context.tokens === undefined ? null : (context.tokens / context.window) * 100
  const contextNote = context.tokens === undefined
    ? 'updates after a reply'
    : `${formatTokens(context.tokens)} of ${formatTokens(context.window)}`
  const segments: Segment[] = [
    {
      label: 'context',
      filled: contextPercent ?? 0,
      marked: 0,
      parts: [
        { text: (contextPercent === null ? '—' : `${Math.round(contextPercent)}%`).padEnd(VALUE_COLUMNS), paint: 'fill' },
        { text: ` ${contextNote}`, note: true },
      ],
    },
  ]
  // у обоих лимитов бар — всё окно, цветом сессии выделено то, что потратила сессия; ↻ — время сброса
  const limitSegment = (label: string, kind: WindowKind, formatReset: (iso: string) => string) => {
    const figures = windowFigures(kind)
    if (figures !== null) {
      const { window, mine } = figures
      segments.push({
        label,
        filled: window.percent,
        marked: mine,
        parts: limitParts(window.percent, mine, window.resetsAt ? formatReset(window.resetsAt) : undefined),
      })
    }
  }
  limitSegment('session', 'fiveHour', formatTime)
  limitSegment('week', 'sevenDay', formatDay)
  return segments
}

// Одной строкой с подписями, одной строкой без подписей, а если и так тесно — столбиком без подписей.
function layout(columns: number, segments: readonly Segment[]): { row: boolean; notes: boolean; bar: number } {
  const count = segments.length
  // всё, кроме баров: метка, два пробела вокруг бара, текст справа; между сегментами зазор
  const rowWidth = (notes: boolean) => segments.reduce(
    (sum, segment) => sum + segment.label.length + 2 + partsWidth(segment.parts, notes), 0,
  ) + (count - 1) * SEGMENT_GAP + MARKER_COLUMNS
  const withNotes = Math.min(BAR_COLUMNS.max, Math.floor((columns - rowWidth(true)) / count))
  if (withNotes >= BAR_COLUMNS.min) {
    return { row: true, notes: true, bar: withNotes }
  }
  const bare = Math.min(BAR_COLUMNS.max, Math.floor((columns - rowWidth(false)) / count))
  if (bare >= BAR_COLUMNS.min) {
    return { row: true, notes: false, bar: bare }
  }
  const figures = Math.max(...segments.map(segment => partsWidth(segment.parts, false)))
  return { row: false, notes: false, bar: Math.min(BAR_COLUMNS.max, columns - LABEL_COLUMNS - figures - 2 - MARKER_COLUMNS) }
}

async function tick($: EngineInterface): Promise<void> {
  await refresh($)
  const signature = JSON.stringify([windowFigures('fiveHour'), windowFigures('sevenDay'), context?.tokens, context?.window])
  if (signature !== drawn) {
    drawn = signature
    $.ui.invalidate('ui.render')
  }
}

async function prune($: EngineInterface): Promise<void> {
  const now = Date.now()
  for (const key of await $.store.keys()) {
    if (LEGACY_KEYS.includes(key)) {
      await $.store.delete(key)
      continue
    }
    if (!key.startsWith('session:')) {
      continue
    }
    const saved = (await $.store.get(key)) as SessionState | undefined
    if (!saved || now - saved.touchedAt > SESSION_TTL_MS) {
      await $.store.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Кеш промпта: строка под барами, /cache и тосты перед истечением. Вклеено из мода
// prompt-cache-control (github.com/davila7/claude-code-templates, MIT, см. ../NOTICE.md),
// арифметика лежит в ./cache.ts без изменений. Свои правки помечены «UsageBar:».

const PANE = 'cache'
const COMMAND = 'cache'
const KEEP = 200
// below this a lapsed cache costs too little to interrupt anyone about
const TOAST_MIN_TOKENS = 20_000

let samples: Sample[] = []
let ttl: Ttl = '5m'
let baseTtl: Ttl = '5m'
let pinned = false
let observed: Ttl | undefined
let setting: unknown
let account: Account = 'other'
let ttlSource = 'default'
let envSource = 'default'
let env: CacheEnv = {}
let cacheTimer: { cancel: () => void } | undefined // UsageBar: в оригинале timer, имя занято баром лимитов
let cacheStarted = false // UsageBar: после перезагрузки модуля кеш поднимается из отрисовки
let lastKey = ''
let toastedFor = 0
let toastLevel = Infinity
let isPaneOpen = false

type CachePolicy = { warnMs: number; compactAtTokens: number }
// UsageBar: настройки кеша одним объектом. В оригинале ключи ttl, warnSeconds, compactAtTokens, band,
// status, toast; здесь у них префикс cache, чтобы в /config было видно, к чему они относятся
type CacheConfig = { policy: CachePolicy; ttlOption: unknown; showRow: boolean; showStatus: boolean; wantToast: boolean }

function current(policy: CachePolicy, now: number) {
  const last = samples[samples.length - 1]
  const prev = samples[samples.length - 2]
  const disabled = last ? isCachingDisabled(last.model, env) : isCachingDisabled('', env)
  const advice: Advice = advise(last, prev, { ttl, ...policy }, now, disabled)
  const left = last ? remainingMs(last, ttl, now) : 0
  return { last, advice, left }
}

const COLOR: Record<Advice['kind'], string | undefined> = {
  warm: 'green',
  soon: 'yellow',
  expired: 'red',
  miss: 'red',
  off: undefined,
  cold: undefined,
  uncached: undefined,
}

function shortLine(policy: CachePolicy, now: number): string {
  const { last, advice, left } = current(policy, now)
  if (!last || advice.kind === 'off') return `cache: ${advice.text}`
  const clock = left > 0 ? ` · ${fmtClock(left)}` : ''
  return `cache ${Math.round(hitRatio(last) * 100)}%${clock}`
}

// UsageBar: строка кеша в стиле баров. Бар — состав последнего запроса: основным цветом прочитанное из кеша,
// цветом сессии записанное в кеш этим запросом (то, что добавилось сейчас, как +N% у лимитов). Справа через |:
// доля из кеша, read, wrote, new, ⏱ до истечения. Цветом заполнения доля, цветом сессии wrote, остальное тусклое;
// отсчёт загорается цветом сессии, только когда кеш вот-вот истечёт или истёк, подсказка — только когда кеш не тёплый.
// Когда тесно, первыми пропадают read, new и подсказка. В оригинале здесь светофор из зелёного, жёлтого и красного
function cacheSegment(last: Sample, advice: Advice, left: number): Segment {
  if (advice.kind === 'uncached') {
    return { label: 'cache', filled: 0, marked: 0, parts: [{ text: '—', paint: 'fill' }, { text: `${DIVIDER}not cached` }] }
  }
  const total = promptTokens(last)
  const share = (tokens: number) => (total === 0 ? 0 : (tokens / total) * 100)
  const urgent = advice.kind === 'soon' || advice.kind === 'expired'
  const parts: Part[] = [
    { text: `${Math.round(hitRatio(last) * 100)}%`, paint: 'fill' },
    { text: `${DIVIDER}read ${fmtTokens(last.read)}`, note: true },
    { text: DIVIDER },
    { text: `wrote ${fmtTokens(last.write)}`, paint: 'mark' },
    { text: `${DIVIDER}new ${fmtTokens(last.fresh)}`, note: true },
    { text: DIVIDER },
    urgent ? { text: `⏱${fmtClock(left)}`, paint: 'mark' } : { text: `⏱${fmtClock(left)}` },
  ]
  if (advice.kind !== 'warm') {
    parts.push({ text: ` · ${advice.text}`, note: true })
  }
  return { label: 'cache', filled: share(last.read + last.write), marked: share(last.write), parts }
}

// the promptCacheTtl setting, from the settings files that can carry it (local over project over user)
async function readSetting($: EngineInterface): Promise<unknown> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const cwd = await $.session.cwd().catch(() => undefined)
  const files = [cwd && `${cwd}/.claude/settings.local.json`, cwd && `${cwd}/.claude/settings.json`, home && `${home}/.claude/settings.json`]
  for (const file of files) {
    if (!file) continue
    try {
      const value = JSON.parse(await $.fs.read(file)).promptCacheTtl
      if (value === '5m' || value === '1h') return value
    } catch {
      // missing or unreadable: the next file
    }
  }
  return undefined
}

// UsageBar: тело session.start оригинала, вынесено в функцию, чтобы звать и из отрисовки
async function startCache($: EngineInterface, config: CacheConfig): Promise<void> {
  cacheStarted = true
  samples = []
  lastKey = ''
  toastedFor = 0
  const none = () => undefined
  env = {
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
    ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
    disableAll: await $.env.get('DISABLE_PROMPT_CACHING').catch(none),
    disableHaiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(none),
    disableSonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(none),
    disableOpus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(none),
  }
  pinned = config.ttlOption === '5m' || config.ttlOption === '1h'
  observed = undefined
  setting = await readSetting($)
  account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
  const choice = decideTtl(config.ttlOption, env, setting, account)
  baseTtl = choice.ttl
  ttl = baseTtl
  envSource = choice.source
  ttlSource = envSource

  await $.command
    .register({
      name: COMMAND,
      description: 'Prompt-cache usage per turn and the time left before it lapses (stop closes)',
      argumentHint: '[stop]',
      immediate: true,
    })
    .catch(err => $.ui.log(`usage-bar: /${COMMAND} not registered: ${err}`))
  $.ui.log(`usage-bar cache: ${ttl} cache (${ttlSource}), /${COMMAND} opens the table`, { to: 'debug' })

  cacheTimer?.cancel()
  cacheTimer = $.clock.every(1000, () => {
    const now = Date.now()
    const { last, advice, left } = current(config.policy, now)
    const key = `${advice.kind}|${advice.text}|${left > 0 ? fmtClock(left) : ''}`
    if (key !== lastKey) {
      lastKey = key
      if (config.showStatus) $.ui.status(shortLine(config.policy, now))
      $.ui.invalidate('ui.render')
    }
    if (config.wantToast && last && left > 0 && promptTokens(last) >= TOAST_MIN_TOKENS) {
      if (toastedFor !== last.startedAt) {
        toastedFor = last.startedAt
        toastLevel = Infinity
      }
      // the first toast comes at warnSeconds, then 10, 3, 2 and 1 seconds; a late tick skips to the newest one
      const secs = Math.ceil(left / 1000)
      const mark = nextToastMark(secs, config.policy.warnMs / 1000, toastLevel)
      if (mark !== undefined) {
        toastLevel = mark
        const tail = secs <= COUNTDOWN_MARKS[0]! ? 'send a message now' : `send a message to keep ${fmtTokens(promptTokens(last))} tokens warm`
        $.ui.toast(`cache expires in ${secs >= 60 ? fmtClock(left) : `${secs}s`}: ${tail}`)
      }
    }
  })
}

export const register: Register = (on, options) => {
  const colors: Record<Paint, string> = {
    fill: paletteColor(options.color, 'Default'),
    mark: paletteColor(options.sessionColor, 'Claude'),
    free: 'gray',
  }
  const cacheConfig: CacheConfig = {
    policy: {
      warnMs: positive(options.cacheWarnSeconds, 60) * 1000,
      compactAtTokens: positive(options.cacheCompactAtTokens, 100_000),
    },
    ttlOption: options.cacheTtl,
    showRow: options.cacheRow !== false,
    showStatus: options.cacheStatus === true,
    wantToast: options.cacheToast !== false,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.isInteractive) {
      await prune($)
      await refresh($)
      timer ??= $.clock.every(REFRESH_MS, () => {
        tick($).catch(() => undefined)
      })
      // отрисовка могла поднять кеш раньше, пока шёл этот хук; тогда только начать отсчёт заново
      if (cacheStarted) {
        samples = []
        lastKey = ''
        toastedFor = 0
      } else {
        await startCache($, cacheConfig)
      }
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    // /clear starts a new conversation in the same process: its cache is a new one
    if (e.reason === 'clear') {
      samples = []
      lastKey = ''
      toastedFor = 0
      observed = undefined
      ttl = baseTtl
      ttlSource = envSource
      $.ui.invalidate('ui.render')
      return next(e)
    }
    cacheTimer?.cancel()
    cacheTimer = undefined
    return next(e)
  })

  // each main-loop request: what the cache did with it
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = Date.now()
    const r = yield* next(e)
    if (r.usage) {
      samples.push({
        turnId: e.turnId,
        index: e.index,
        model: r.usage.model || e.model,
        startedAt,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
        fresh: r.usage.input_tokens,
        output: r.usage.output_tokens,
      })
      if (samples.length > KEEP) samples = samples.slice(-KEEP)
      if (!pinned) {
        // the account can change under a session: a subscription running out of plan usage moves to usage credits
        account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
        const choice = decideTtl(cacheConfig.ttlOption, env, setting, account)
        baseTtl = choice.ttl
        envSource = choice.source
        if (observed === undefined) {
          ttl = baseTtl
          ttlSource = envSource
        }
        const seen = observeTtl(samples[samples.length - 2], samples[samples.length - 1]!, observed)
        if (seen !== observed) {
          observed = seen
          ttl = seen ?? baseTtl
          ttlSource = `observed from request timing; ${envSource} said ${baseTtl}`
          $.ui.log(`usage-bar: cache lifetime is ${ttl} (${ttlSource})`, { to: 'debug' })
        }
      }
      lastKey = ''
      if (cacheConfig.showStatus) $.ui.status(shortLine(cacheConfig.policy, Date.now()))
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'stop') {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      isPaneOpen = false
      return { text: 'cache table closed' }
    }
    isPaneOpen = true
    await $.ui.open({ id: PANE, title: 'cache', focus: true })
    $.ui.invalidate('ui.render')
    const { advice } = current(cacheConfig.policy, Date.now())
    return { text: `${ttl} cache (${ttlSource}) · ${advice.text} · /${COMMAND} stop closes` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    isPaneOpen = false
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || e.requestId !== PANE) return next(e)
    if (e.element === 'close') await $.ui.close({ id: PANE }).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) {
      return next(e)
    }
    if (session === null) {
      await refresh($)
    }
    // после перезагрузки модуля session.start не приходит, таймеры заводятся здесь
    timer ??= $.clock.every(REFRESH_MS, () => {
      tick($).catch(() => undefined)
    })
    if (!cacheStarted) {
      await startCache($, cacheConfig)
    }

    // строка баров: context, session, week
    const segments = context === null ? null : usageSegments(context)
    const fit = segments === null ? null : layout(e.props.bodyColumns, segments)
    const usage = segments !== null && fit !== null && fit.bar >= BAR_COLUMNS.min ? { segments, fit } : null

    // строка кеша: UsageBar: в оригинале отдельная полоса, здесь вторая строка под барами. Пока открыт /cache,
    // строки нет, как и полосы в оригинале
    const { last, advice, left } = current(cacheConfig.policy, Date.now())
    const showCache = cacheConfig.showRow && !isPaneOpen && (!!last || advice.kind === 'off')

    if (usage === null && !showCache) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns // UsageBar: в оригинале e.viewport.columns
    const cache = showCache && last && advice.kind !== 'off' ? cacheSegment(last, advice, left) : null
    // бар кеша той же ширины, что и бары лимитов; подсказка справа, только если влезает
    const cacheBarWidth = usage?.fit.bar ?? BAR_COLUMNS.min
    const cacheNotes = cache !== null && cache.label.length + 2 + cacheBarWidth + partsWidth(cache.parts, true) <= columns
    const drawSegment = (segment: Segment, barWidth: number, notes: boolean, label: string) => (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{label}</Text>
        <Box flexDirection="row">
          {bar(barWidth, segment.filled, segment.marked).map(run => (
            <Text
              color={colors[run.color]}
              {...(run.background ? { backgroundColor: colors[run.background] } : {})}
              {...(run.color === 'free' ? { dimColor: true } : {})}
            >
              {run.text}
            </Text>
          ))}
        </Box>
        <Text>
          {segment.parts.filter(part => notes || !part.note).map(part => (
            part.paint
              ? <Text color={colors[part.paint]} bold>{part.text}</Text>
              : <Text dimColor>{part.text}</Text>
          ))}
        </Text>
      </Box>
    )
    const below = await next(e)
    // обе строки по центру полосы, вплотную; то, что рисует движок, остаётся как было
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" alignItems="center">
          {usage !== null ? (
            <Box flexDirection={usage.fit.row ? 'row' : 'column'} columnGap={SEGMENT_GAP}>
              {usage.segments.map(segment => drawSegment(
                segment, usage.fit.bar, usage.fit.notes, usage.fit.row ? segment.label : segment.label.padEnd(LABEL_COLUMNS),
              ))}
            </Box>
          ) : null}
          {showCache && cache === null ? (
            <Text dimColor>{fitText(`cache: ${advice.text}`, columns)}</Text>
          ) : null}
          {cache !== null ? drawSegment(cache, cacheBarWidth, cacheNotes, 'cache') : null}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 1)
    // HTML collapses runs of spaces and trims a text's ends; a no-break space keeps them
    const sp = (t: string) => (e.surface === 'terminal' ? t : t.replace(/ /g, ' '))
    const now = Date.now()
    const { last, advice, left } = current(cacheConfig.policy, now)
    const all = byTurn(samples)
    const counting = !!last && advice.kind !== 'uncached' && advice.kind !== 'off'
    // the countdown goes green, then yellow, then red as the cache runs out
    const clockColor = counting ? lifeColor(left, ttl, cacheConfig.policy.warnMs) : undefined
    const stateColor = advice.kind === 'expired' || advice.kind === 'miss' ? 'red' : (clockColor ?? COLOR[advice.kind])
    const hitColor = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')
    // solid bars are filled Boxes, not block characters, so HTML draws no seams between cells
    const solid = (key: string, parts: [number, string | undefined][]) => (
      <Box key={key} flexDirection="row" height={1} flexShrink={0}>
        {parts.map(([w, c], i) => (w > 0 ? <Box key={`${key}:${i}`} width={w} height={1} flexShrink={0} backgroundColor={c} /> : null))}
      </Box>
    )
    const cell = (key: string, w: number, text: string, c?: string, bold = false) => (
      <Box key={key} width={w} flexShrink={0} justifyContent="flex-end">
        <Text color={c} bold={bold} dimColor={!c}>{sp(text)}</Text>
      </Box>
    )

    const barW = Math.min(width, 40)
    const life = lifeRatio(left, ttl)
    const lifeFilled = Math.round(life * barW)
    const [sr, sw, sn] = last ? cacheSegments(last.read, last.write, last.fresh, barW) : [0, 0, 0]
    const rows = all.slice(-Math.max(3, (e.viewport?.rows ?? 24) - 16))
    const icon = advice.kind === 'warm' ? '●' : advice.kind === 'soon' ? '▲' : advice.kind === 'expired' || advice.kind === 'miss' ? '✖' : '○'

    return (
      <Box flexDirection="column">
        <Box key="title" flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{sp('⚡ PROMPT CACHE')}</Text>
          <Text dimColor>{sp(`· ${ttl} lifetime (${ttlSource})`)}</Text>
        </Box>

        <Box key="clock" flexDirection="column" marginTop={1}>
          <Text bold color={clockColor}>{sp(counting ? `⏱ ${left > 0 ? fmtClock(left) : '0:00'}` : '⏱ --:--')}</Text>
          {counting ? (
            <Box flexDirection="row" columnGap={1}>
              {solid('life', [[lifeFilled, clockColor], [barW - lifeFilled, 'gray']])}
              <Text dimColor>{sp(`${Math.round(life * 100)}%`)}</Text>
            </Box>
          ) : null}
        </Box>

        <Box key="advice" marginTop={1} flexDirection="column">
          <Text bold color={stateColor}>{sp(`${icon} ${advice.text}`)}</Text>
          {last ? <Text dimColor>{sp(fitText(`${last.model} · prompt ${fmtTokens(promptTokens(last))} tokens`, width))}</Text> : null}
        </Box>

        {last ? (
          <Box key="stack" flexDirection="column" marginTop={1}>
            <Box flexDirection="row" columnGap={1}>
              {solid('stack', [[sr, 'green'], [sw, 'yellow'], [sn, 'cyan']])}
              <Text bold color={hitColor(Math.round(hitRatio(last) * 100))}>{sp(`${Math.round(hitRatio(last) * 100)}% hit`)}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2}>
              <Text color="green">{sp(`■ read ${fmtTokens(last.read)}`)}</Text>
              <Text color="yellow">{sp(`■ wrote ${fmtTokens(last.write)}`)}</Text>
              <Text color="cyan">{sp(`■ new ${fmtTokens(last.fresh)}`)}</Text>
            </Box>
          </Box>
        ) : null}

        <Box key="table" flexDirection="column" marginTop={1}>
          <Box key="head" flexDirection="row" columnGap={1}>
            {cell('h:turn', 4, 'turn', 'cyan', true)}
            {cell('h:steps', 5, 'steps', 'cyan', true)}
            {cell('h:read', 6, 'read', 'green', true)}
            {cell('h:wrote', 6, 'wrote', 'yellow', true)}
            {cell('h:new', 5, 'new', 'cyan', true)}
            {cell('h:hit', 4, 'hit', 'magenta', true)}
          </Box>
          {rows.length === 0 ? <Text dimColor>{sp('no requests yet')}</Text> : null}
          {rows.map((row, i) => {
            const n = all.length - rows.length + i + 1
            const pct = Math.round(rowRatio(row) * 100)
            return (
              <Box key={`t:${row.turnId}`} flexDirection="row" columnGap={1}>
                {cell(`c:turn:${row.turnId}`, 4, String(n))}
                {cell(`c:steps:${row.turnId}`, 5, String(row.steps))}
                {cell(`c:read:${row.turnId}`, 6, fmtTokens(row.read), 'green')}
                {cell(`c:wrote:${row.turnId}`, 6, fmtTokens(row.write), 'yellow')}
                {cell(`c:new:${row.turnId}`, 5, fmtTokens(row.fresh), 'cyan')}
                {cell(`c:hit:${row.turnId}`, 4, `${pct}%`, hitColor(pct), true)}
              </Box>
            )
          })}
        </Box>

        <Box key="foot" marginTop={1} flexDirection="column">
          <Button key="close" label="close" onPress={() => {}} />
          <Box key="legend" marginTop={1} flexDirection="column">
            <Text color="green">{sp('■ read: served by the cache')}</Text>
            <Text color="yellow">{sp('■ wrote: new cache entry')}</Text>
            <Text color="cyan">{sp('■ new: sent uncached')}</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
