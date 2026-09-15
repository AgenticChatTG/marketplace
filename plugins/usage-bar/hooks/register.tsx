import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import { bar, formatDay, formatTime, formatTokens, freshSession, limitParts, partsWidth, resumed, sameWindow, track } from './meter'
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
    session = typeof saved?.banked === 'object' && saved.windows ? resumed(saved) : freshSession(id)
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
function windowFigures(kind: WindowKind): { window: Limit; mine: number; total: number } | null {
  const window = live(limits[kind])
  if (session === null || window === undefined) {
    return null
  }
  const tracked = session.windows[kind]
  const spent = tracked ? Math.max(0, tracked.last - tracked.base) : 0
  const inWindow = tracked !== undefined && sameWindow(tracked.resetsAt, window.resetsAt)
  return { window, mine: inWindow ? Math.min(window.percent, spent) : 0, total: session.banked[kind] + spent }
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

export const register: Register = (on, options) => {
  const colors: Record<Paint, string> = {
    fill: paletteColor(options.color, 'Default'),
    mark: paletteColor(options.sessionColor, 'Claude'),
    free: 'gray',
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.isInteractive) {
      await prune($)
      await refresh($)
      timer ??= $.clock.every(REFRESH_MS, () => {
        tick($).catch(() => undefined)
      })
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) {
      return next(e)
    }
    if (session === null) {
      await refresh($)
    }
    // после перезагрузки модуля session.start не приходит, таймер заводится здесь
    timer ??= $.clock.every(REFRESH_MS, () => {
      tick($).catch(() => undefined)
    })
    if (context === null) {
      return next(e)
    }

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
        const { window, mine, total } = figures
        segments.push({
          label,
          filled: window.percent,
          marked: mine,
          parts: limitParts(window.percent, total, window.resetsAt ? formatReset(window.resetsAt) : undefined),
        })
      }
    }
    limitSegment('session', 'fiveHour', formatTime)
    limitSegment('week', 'sevenDay', formatDay)

    const fit = layout(e.props.bodyColumns, segments)
    if (fit.bar < BAR_COLUMNS.min) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection={fit.row ? 'row' : 'column'} columnGap={SEGMENT_GAP}>
          {segments.map(segment => (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{fit.row ? segment.label : segment.label.padEnd(LABEL_COLUMNS)}</Text>
              <Box flexDirection="row">
                {bar(fit.bar, segment.filled, segment.marked).map(run => (
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
                {segment.parts.filter(part => fit.notes || !part.note).map(part => (
                  part.paint
                    ? <Text color={colors[part.paint]} bold>{part.text}</Text>
                    : <Text dimColor>{part.text}</Text>
                ))}
              </Text>
            </Box>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}
