# omni-release-cli

UI local (Express + SSE) para automatizar fluxo de versionamento/merge/hotfix do projeto **/New-Omni**
(bump de versão semântica, merge develop→release, release→main, hotfix via cherry-pick, pause em conflitos, etc).

## Requisitos
- Node.js 18+ (recomendado 20+)
- Git instalado
- O repositório alvo disponível em `/New-Omni` (ajuste no `server.mjs` se necessário)

## Instalação
```bash
npm install
