# Чужой код в UsageBar

Строка кеша, команда `/cache` и их настройки взяты из мода **prompt-cache-control** проекта
[claude-code-templates](https://github.com/davila7/claude-code-templates)
(`cli-tool/components/mods/observability/prompt-cache-control`, коммит `55457cf` от 4 окт 2026):

- `hooks/cache.ts` скопирован целиком, правка одна: три `!` в `segments()` под строгий режим TypeScript;
- хуки и отрисовка кеша в `hooks/register.tsx` вклеены из `prompt-cache-control.tsx`, свои правки там помечены;
- `tests/cache.test.tsx` взят из `tests/cache.test.tsx` того же мода и подогнан под UsageBar.

Лицензия оригинала:

```
MIT License

Copyright (c) 2025 Daniel (San) Ávila

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
