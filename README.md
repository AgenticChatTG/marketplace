# agentic-chat — каталог модулей для Claude Code

Marketplace орга **AgenticChatTG**: скиллы, сабагенты, слэш-команды, MCP-серверы, хуки и моды. Всё публичное, берётся **поштучно**.

*Public Claude Code plugin catalog. Add it with `/plugin marketplace add AgenticChatTG/marketplace`, install with `/plugin install <name>@agentic-chat`.*

## Подключить (один раз)

```
/plugin marketplace add AgenticChatTG/marketplace
```

## Взять модуль

```
/plugin marketplace update             # подтянуть свежий список
/plugin install <имя>@agentic-chat     # поставить
/plugin list                           # что стоит
/plugin uninstall <имя>@agentic-chat   # убрать
```

## Модули

| Модуль | Что делает | Требования |
| :-- | :-- | :-- |
| [`usage-bar`](plugins/usage-bar) | Над полем ввода три бара: заполненность контекстного окна, расход пятичасового лимита за сессию, недельный лимит | Claude Code 2.1.272+, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, подписка Pro или Max |

## Структура

```
marketplace/
├── .claude-plugin/marketplace.json   # каталог: какие модули есть
└── plugins/
    └── <имя-плагина>/
        ├── .claude-plugin/plugin.json
        ├── README.md
        └── skills/ agents/ commands/ hooks/ .mcp.json
```

Только `plugin.json` живёт в `.claude-plugin/`, всё остальное — в корне плагина.

## Как добавить свой модуль

Положи плагин в `plugins/<имя>/` вместе с README, добавь запись в `.claude-plugin/marketplace.json` и открой PR из ветки или форка. Подробные правила — в [CLAUDE.md](CLAUDE.md) и README орга. Всё в репозитории публичное, включая историю: никаких секретов и личных данных.

## Лицензия

MIT, см. [LICENSE](LICENSE), если в папке модуля не указано иное.
