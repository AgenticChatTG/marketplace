// Арифметика мода без $: окно лимита, раскладка бара, подписи.

const WINDOW_JITTER_MS = 30 * 60 * 1000

// resetsAt одного окна может немного плавать, новое окно начинается на часы позже.
export function sameWindow(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  return Math.abs(Date.parse(a) - Date.parse(b)) < WINDOW_JITTER_MS
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
