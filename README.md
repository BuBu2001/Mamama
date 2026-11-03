# CryptoSim — обучающий симулятор криптобиржи (paper trading)

Браузерная игра-симулятор: старт 100 USD, спот-торговля, стакан, комиссии,
слиппедж, P&L, налоги (US), KYC/AML, боты с памятью, сейвы в IndexedDB.
**Никаких реальных денег и backend не требуется.** Стек: TypeScript + Vite + React + Zustand + Tailwind + decimal.js + Dexie + lightweight-charts + Vitest.

## Требования
- Node.js **18+** (лучше 20 LTS или новее) — https://nodejs.org (LTS installer)
- npm входит в поставку Node.js

## Запуск на Windows

### Вариант 1: PowerShell / Командная строка (cmd)
1. Установите Node.js LTS с https://nodejs.org (или `winget install OpenJS.NodeJS.LTS`).
2. Откройте папку проекта:
   - в Проводнике нажмите в адресной строке путь, введите `powershell` и Enter —
     откроется PowerShell прямо в этой папке;
   - либо `Win+R` → `cmd` → `cd C:\путь\к\проекту`.
3. Выполните команды:
```bat
cd C:\путь\к\папке\с\проектом
npm install
npm run dev
```
4. Откройте в браузере адрес, который выведет Vite (обычно http://localhost:5173).
5. Остановить сервер: `Ctrl+C` в терминале.

⚠️ Не кладите проект в пути с кириллицей/пробелами, если видите странные ошибки — лучше `C:\dev\cryptosim`.

### Вариант 2: VS Code (самый простой)
1. Установите VS Code, откройте папку проекта (`File → Open Folder`).
2. `Ctrl+`` — откроется встроенный терминал.
3. Введите `npm install`, затем `npm run dev`, затем кликните по ссылке http://localhost:5173 в терминале.

### Вариант 3: WSL (опционально)
```bash
wsl --install
# внутри WSL (Ubuntu):
sudo apt update && sudo apt install -y nodejs npm   # или лучше nvm: https://github.com/nvm-sh/nvm
cd /mnt/c/путь/к/проекту && npm install && npm run dev
```

## Проверка после установки
```bat
npm test          # юнит-тесты Vitest (matching, fees, slippage, liquidation, taxes, RNG...)
npm run typecheck # проверка типов TypeScript
npm run build     # прод-сборка в dist/ (статика, работает без сервера)
npm run preview   # локальный предпросмотр собранной версии
```

## Запуск на macOS / Linux
Те же команды: `npm install && npm run dev`.

## Данные рынка
По умолчанию игра работает полностью офлайн на детерминированном Mock-провайдере
(статус источника виден в шапке: LIVE / MOCK / STALE / OFFLINE). Live-данные Binance
в dev идут через Vite-прокси (`vite.config.ts`); в проде MVP работает без сервера.

## Дисклеймер
Учебная песочница. Не является финансовой, налоговой или юридической рекомендацией.
Все «серые» схемы (pump & dump, wash trading и т.п.) — игровые механики с наказанием,
а не инструкции к действию.
