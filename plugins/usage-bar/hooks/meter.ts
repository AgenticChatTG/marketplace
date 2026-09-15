// Арифметика мода без $: окно лимита, раскладка бара, подписи.

const WINDOW_JITTER_MS = 30 * 60 * 1000

// resetsAt одного окна может немного плавать, новое окно начинается на часы позже.
export function sameWindow(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  return Math.abs(Date.parse(a) - Date.parse(b)) < WINDOW_JITTER_MS
}

const RESET_SEEN_MS = 10 * 60 * 1000 // сброс окна замечен вовремя, если с него прошло меньше

export type WindowKind = 'fiveHour' | 'sevenDay'
export type Limit = { percent: number; resetsAt?: string }
// Процент окна, с которого сессия его тратит, и последний. stale — последнее чтение могло устареть,
// и пока сессия не получит ответ модели, прирост окна тратит не она.
export type Tracked = { resetsAt?: string; base: number; last: number; stale?: boolean }

// Что мод помнит о сессии. Лежит в $.store: переменные модуля теряются при перезагрузке.
export type SessionState = {
  id: string
  windows: Partial<Record<WindowKind, Tracked>>
  banked: Record<WindowKind, number> // потрачено сессией в прошлых окнах
  touchedAt: number
}

export function freshSession(id: string): SessionState {
  return { id, windows: {}, banked: { fiveHour: 0, sevenDay: 0 }, touchedAt: 0 }
}

// Сессия из хранилища: её продолжили (claude -c, /resume) или перезагрузили мод. Сколько окна набрали
// с её последнего чтения, неизвестно, этот прирост ей не засчитывается.
export function resumed(state: SessionState): SessionState {
  for (const window of Object.values(state.windows)) {
    if (window !== undefined) {
      window.stale = true
    }
  }
  return state
}

// Сдвигает отметку сессии в окне по новому чтению; true, если отметка поменялась.
// replied — сессия получила ответ модели с тех пор, как её отметки могли устареть.
export function track(state: SessionState, kind: WindowKind, { percent, resetsAt }: Limit, replied: boolean, now = Date.now()): boolean {
  const window = state.windows[kind]
  if (window === undefined) {
    // первое чтение за сессию: потраченное в окне до этого момента — не её. До ответа модели
    // чтение досталось от прошлой сессии процесса (после /clear) и тоже могло устареть
    state.windows[kind] = { resetsAt, base: percent, last: percent, ...(replied ? {} : { stale: true }) }
    return true
  }
  if (!sameWindow(window.resetsAt, resetsAt)) {
    // окно сбросилось. Потраченное в старом копится. Если сброс был только что, новое окно
    // сессия тратит с нуля, а если она проспала сброс или стояла — с первого чтения
    const seen = !window.stale && window.resetsAt !== undefined && now - Date.parse(window.resetsAt) < RESET_SEEN_MS
    state.banked[kind] += Math.max(0, window.last - window.base)
    state.windows[kind] = { resetsAt, base: seen ? 0 : percent, last: percent, ...(window.stale && !replied ? { stale: true } : {}) }
    return true
  }
  if (window.stale) {
    // прирост с устаревшего чтения потратили другие сессии, пока эта стояла. Отметка сдвигается
    // целиком, и если с ним совпал первый ответ самой сессии, он уходит тоже: их не различить
    const changed = percent !== window.last || replied
    window.base += percent - window.last
    window.last = percent
    if (replied) {
      delete window.stale
    }
    return changed
  }
  if (percent !== window.last) {
    window.base = Math.min(window.base, percent)
    window.last = percent
    return true
  }
  return false
}

export type Paint = 'fill' | 'mark' | 'free'
export type Run = { text: string; color: Paint; background?: Paint }

const EIGHTHS = ' ▏▎▍▌▋▊▉' // индекс — сколько восьмых клетки закрашено слева

// Бар на 100 %: заполнено filled процентов, из них последние marked процентов выделены,
// дальше свободное. Точность — восьмая клетки; ненулевое выделение видно хотя бы на восьмую.
export function bar(columns: number, filled: number, marked: number): Run[] {
  const total = columns * 8
  const eighths = (percent: number) => Math.min(total, Math.max(0, Math.round((percent / 100) * total)))
  const markedEighths = marked > 0 ? Math.max(1, eighths(marked)) : 0
  const end = Math.max(eighths(filled), markedEighths)
  const start = end - markedEighths

  const runs: Run[] = []
  const push = (char: string, color: Paint, background?: Paint) => {
    const last = runs[runs.length - 1]
    if (last && last.color === color && last.background === background) {
      last.text += char
    } else {
      runs.push(background ? { text: char, color, background } : { text: char, color })
    }
  }

  for (let cell = 0; cell < columns; cell++) {
    const from = cell * 8
    const plain = Math.min(8, Math.max(0, start - from))
    const painted = Math.min(8, Math.max(0, end - from))
    if (painted === 0) {
      push('░', 'free')
    } else if (painted === 8 && plain === 8) {
      push('█', 'fill')
    } else if (painted === 8 && plain === 0) {
      push('█', 'mark')
    } else if (painted === 8) {
      push(EIGHTHS[plain]!, 'fill', 'mark')
    } else if (plain >= painted) {
      push(EIGHTHS[painted]!, 'fill')
    } else if (plain < 8 - painted) {
      // выделение кончается в этой клетке. Если и началось в ней, три цвета в клетку не влезут,
      // и сдвигается граница, которой сдвинуться меньше: здесь начало выделения
      push(EIGHTHS[painted]!, 'mark')
    } else {
      // а здесь конец: выделение дотягивается до края клетки
      push(EIGHTHS[plain]!, 'fill', 'mark')
    }
  }
  return runs
}

export function formatTokens(tokens: number): string {
  const thousands = Math.round(tokens / 1_000)
  if (thousands >= 1_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`
  }
  if (tokens >= 1_000) {
    return `${thousands}k`
  }
  return String(tokens)
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function formatDay(iso: string): string {
  return `${WEEKDAYS[new Date(iso).getDay()]} ${formatTime(iso)}`
}

// Кусок текста справа от бара: цифра своим цветом или тусклый текст. note — подпись, её прячут первой, когда тесно.
export type Part = { text: string; paint?: Paint; note?: boolean }

const DIVIDER = ' | '

// Текст лимита: процент окна | прирост за сессию | ↻ время сброса.
export function limitParts(percent: number, spent: number, reset: string | undefined): Part[] {
  const parts: Part[] = [
    { text: `${Math.round(percent)}%`, paint: 'fill' },
    { text: DIVIDER },
    { text: `+${Math.round(spent)}%`, paint: 'mark' },
  ]
  if (reset !== undefined) {
    parts.push({ text: `${DIVIDER}↻${reset}`, note: true })
  }
  return parts
}

export function partsWidth(parts: readonly Part[], notes: boolean): number {
  return parts.reduce((sum, part) => sum + (notes || !part.note ? part.text.length : 0), 0)
}
