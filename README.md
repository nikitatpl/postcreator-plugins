# Пакет Postcreator для команды

Общий архив содержит **Postcreator** для облачных медиа, **Postcreator Desktop** для программ компьютера и **Postcreator Motion** для монтажа на компьютере: анимированные перебивки, 3D-карточки и субтитры к говорящей голове и монтаж по референсу. Распакуйте в новую постоянную папку, сохранив `.agents`, `.claude-plugin` и обе папки `plugins`. Учётные данные, программы и веса моделей не включены.

Начните с [полного руководства на русском](plugins/postcreator/docs/USER-GUIDE-RU.md).

## Установка и обновление одной командой

Пакет лежит в публичном репозитории [nikitatpl/postcreator-plugins](https://github.com/nikitatpl/postcreator-plugins) — тот же набор, что в архиве на сайте.

Claude Code:

```sh
claude plugin marketplace add nikitatpl/postcreator-plugins
claude plugin install postcreator@itsalab-creative
claude plugin install postcreator-desktop@itsalab-creative
claude plugin install postcreator-motion@itsalab-creative
```

Обновление: `claude plugin marketplace update itsalab-creative`, затем откройте новый чат.

Codex:

```sh
codex plugin marketplace add nikitatpl/postcreator-plugins
codex plugin add postcreator@itsalab-creative
codex plugin add postcreator-desktop@itsalab-creative
codex plugin add postcreator-motion@itsalab-creative
```

Обновление: `codex plugin marketplace upgrade`. Дальше — авторизация и локальная проверка, как описано ниже; вместо пути к распакованному пакету подойдёт папка, которую показывает `codex plugin marketplace list`.

## Установка из архива

Архив с сайта — то же самое без git: распакуйте и добавьте маркетплейс по пути.

### Codex

```sh
codex plugin marketplace add /полный/путь/к/распакованному-пакету
codex plugin add postcreator@itsalab-creative
codex plugin add postcreator-desktop@itsalab-creative
codex plugin add postcreator-motion@itsalab-creative
```

Авторизуйте облачное подключение в своём аккаунте. Для локального сервера нужен Node24+:

```sh
node plugins/postcreator-desktop/runtime/src/cli.mjs doctor
node plugins/postcreator-desktop/runtime/src/cli.mjs setup --register codex
```

Установка копирует локальную среду в новый постоянный каталог и добавляет отсутствующую регистрацию с абсолютными путями. Существующие/отключённые подключения сохраняются; проверьте напечатанное состояние. После обновления откройте новый чат и попросите проверить `pc_desktop_status` и нужную программу без изменений.

### Claude Code

```sh
claude plugin marketplace add /полный/путь/к/распакованному-пакету
claude plugin install postcreator@itsalab-creative
claude plugin install postcreator-desktop@itsalab-creative
claude plugin install postcreator-motion@itsalab-creative
```

Откройте `/mcp` для облачной авторизации и проверки локального сервера. Манифест использует папку установленного плагина и `bootstrap.mjs`, который ищет существующий Node24. Дополнительная регистрация `setup --register claude` — альтернативный маршрут; не создавайте две активные копии локального сервера.

### macOS

Распакуйте ZIP двойным щелчком в Finder в постоянную папку, например `~/Postcreator-suite`; скрытые `.agents` и `.claude-plugin` должны остаться. В «Терминале» выполните `cd ~/Postcreator-suite` и команды выше с `.` вместо полного пути. Node24 подойдёт с nodejs.org или из `brew install node@24`.

Photoshop, Illustrator и After Effects управляются через Apple Events: разрешите управление при первом запросе macOS (Системные настройки → Конфиденциальность и безопасность → Автоматизация). В After Effects включите «Разрешить скриптам записывать файлы и получать доступ к сети». Photoshop на macOS отдаёт PNG; PSD сохраняйте вручную, потому что сохранение из скрипта там вешает программу.

## Монтаж на компьютере

Postcreator Motion работает без отдельного сервера и без MCP: агент вызывает `pc-motion` из папки плагина, а видео обрабатывается на вашем компьютере. Облачное подключение Postcreator нужно ему только для платной генерации недостающих кадров. Нужны Node22+ и FFmpeg; для перебивок — whisper.cpp с моделью. HyperFrames, его Chrome и модель поиска людей в кадре (около 400 МБ вместе со средой, чтобы графика не закрывала говорящего) скачиваются сами при первом использовании. Проверка и установка недостающего (с вашего согласия):

```sh
node plugins/postcreator-motion/runtime/src/cli.mjs doctor
node plugins/postcreator-motion/runtime/src/cli.mjs doctor --fix --yes
```

Каждый ролик — отдельная папка проекта; ваши исходные файлы не меняются. Подробнее — [Postcreator Motion](postcreator-motion/README.md).

## Безопасная первая проверка

Прочитайте аккаунт, каталог моделей и сценариев без генерации. Проверьте тип выполнения — облако, локальная программа, инструменты ассистента или аккаунт. Проверьте одну программу в режиме чтения. Код адаптера и каталог операций не доказывают наличие приложения, лицензии, панели или рабочего модуля скриптов.

Установка через реальные CLI проверена в отдельном тестовом профиле. Платная генерация и работа на другом компьютере требуют своей проверки. Новые облачные возможности должны быть отдельно выложены на сервер.
