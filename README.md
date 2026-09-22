<p align="center">
  <img src="src/icons/icon128.png" width="96" alt="GC Encounters">
</p>

<h1 align="center">GC Encounters</h1>

<p align="center">
  Quantas vezes você já cruzou com cada jogador da GamersClub — direto na lobby,<br>
  no perfil e na tela de partida.
</p>

<p align="center">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-f5a524">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178c6">
  <img alt="esbuild" src="https://img.shields.io/badge/build-esbuild-ffcf00">
  <img alt="Vitest" src="https://img.shields.io/badge/testes-Vitest-6e9f18">
  <img alt="Privacidade" src="https://img.shields.io/badge/dados-100%25%20locais-2ea44f">
</p>

---

Você entra na lobby e tem a impressão de já ter jogado com aquele cara. A GamersClub
não responde isso em lugar nenhum. O GC Encounters registra os jogadores das suas
partidas e mostra, no momento em que importa, quantas vezes vocês já se cruzaram:
quantas contra, quantas no mesmo time, quando foi a última e qual seu aproveitamento.

**Tudo fica na sua máquina.** Sem backend, sem conta, sem telemetria. A extensão só
conversa com `gamersclub.com.br` e nunca interage com o CS2.

## Sumário

- [Funcionalidades](#funcionalidades)
- [Tecnologias](#tecnologias)
- [Rodando localmente](#rodando-localmente)
- [Instalando no Chrome](#instalando-no-chrome)
- [Primeiro uso](#primeiro-uso)
- [Scripts](#scripts)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Arquitetura](#arquitetura)
- [Regras que o código respeita](#regras-que-o-código-respeita)
- [Manutenção: quando a GC muda o site](#manutenção-quando-a-gc-muda-o-site)
- [Publicando na Chrome Web Store](#publicando-na-chrome-web-store)
- [Privacidade](#privacidade)

## Funcionalidades

| Onde | O que aparece |
|---|---|
| **Lobby / vetos** | Selo discreto sobre o avatar de cada jogador já visto. Quem você nunca encontrou não mostra nada. |
| **Selo (clique)** | Partidas em comum com mapa, placar, resultado, contra/junto e aproveitamento. |
| **Perfil do jogador** | Cartão com o resumo do histórico de vocês. |
| **Página de partida** | Coleta silenciosa dos 10 jogadores, com K/D quando a GC fornece. |
| **Página da extensão** | Contadores, ranking de reencontros, busca, anotações por jogador. |
| **Varredura** | Percorre seu histórico em `/my-matches` com throttle (mínimo 2,5 s entre requisições) e cursor retomável. |
| **Agregador** | Você (sempre incluído) + até 4 jogadores: V/D, K/D e mapas das partidas com todos em campo. |
| **Mapas** | Por jogador: mapas mais jogados juntos e embates (quando jogaram contra, com seu V/D e o K/D de cada lado). No seu perfil, todas as suas partidas. |
| **Seus dados** | Exportar/importar o banco em JSON, recalcular contadores, apagar tudo. |

## Tecnologias

| Camada | Tecnologia | Por quê |
|---|---|---|
| Plataforma | **Chrome Extension Manifest V3** | Padrão exigido pela Chrome Web Store. Service worker no lugar de background page. |
| Linguagem | **TypeScript 5.7** (strict) | Tipos para o modelo de partida/jogador e para as mensagens entre scripts. |
| Build | **esbuild** | Um bundle IIFE por entry, sem code splitting (content scripts MV3 não aceitam ESM). Minificado em produção. |
| Banco | **IndexedDB** (wrapper próprio em `src/lib/idb.ts`) | Local, sem limite prático de tamanho, com índices para as consultas de reencontro. |
| UI | **HTML + CSS + DOM puro** | Sem framework: bundle pequeno e nada para a revisão da loja questionar. Selos em **Shadow DOM** para não colidir com o CSS da GC. |
| Testes | **Vitest** + **happy-dom** + **fake-indexeddb** | Parser, repositório, migrações, throttle e backfill testados sem navegador. |
| Empacotamento | `package.mjs` (zip escrito à mão, zero dependência) | Gera o `.zip` da loja a partir de `dist/`, sem fonte nem `node_modules`. |

## Rodando localmente

### Pré-requisitos

- **Node.js 20+** (desenvolvido com 22)
- **npm** 10+
- **Google Chrome** (ou Edge/Brave, qualquer Chromium 114+)
- Uma conta na **GamersClub**, para ver a extensão funcionando

### Passo a passo

```bash
# 1. clonar
git clone https://github.com/RobertorNeto/gc-encounters.git
cd gc-encounters

# 2. instalar dependências (só de desenvolvimento, nada vai para o pacote)
npm install

# 3. gerar a extensão em dist/
npm run build

# 4. (opcional) conferir se está tudo certo
npm run typecheck
npm test
```

Durante o desenvolvimento, `npm run watch` recompila a cada alteração, com sourcemap
inline. Depois de cada rebuild, clique em **Recarregar** no card da extensão em
`chrome://extensions`.

## Instalando no Chrome

1. Abra `chrome://extensions`.
2. Ligue o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação**.
4. Escolha a pasta **`dist/`** do projeto.
5. Fixe o ícone laranja na barra, se quiser acesso rápido à página da extensão.

## Primeiro uso

1. **Faça login** na GamersClub normalmente.
2. **Abra seu próprio perfil** uma vez. É assim que a extensão descobre seu id de
   jogador (também dá para definir à mão na página da extensão).
3. **Abra a página da extensão** (clique no ícone) e confira seus contadores.
4. **Popule o histórico:** em *Varredura do histórico* clique em **Iniciar** e deixe
   uma aba de `gamersclub.com.br/my-matches` aberta. O motor roda nessa aba porque é
   lá que existe a sessão autenticada. Fechou a aba, a varredura pausa; ao reabrir,
   retoma de onde parou.
5. **Jogue.** Na próxima lobby, os jogadores já vistos aparecem com o selo.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run build` | Build de produção em `dist/` (minificado, sem sourcemap). |
| `npm run watch` | Build de desenvolvimento contínuo. |
| `npm test` | Roda a suíte do Vitest uma vez. |
| `npm run test:watch` | Vitest em modo watch. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run package` | Build + zip de publicação em `releases/gc-encounters-<versão>.zip`. |
| `npm run icons` | Redimensiona `src/icons/source.png` nos 4 tamanhos. |
| `node tools/make-icons.mjs` | Desenha o ícone oficial (anel laranja) por código. |

## Estrutura do projeto

```
gc-encounters/
├── src/
│   ├── manifest.json               manifest MV3 (fonte da versão publicada)
│   ├── background/
│   │   ├── service-worker.ts       dono do banco, fila da varredura, throttle
│   │   └── backfill.ts             requisições da varredura (só domínios da GC)
│   ├── content/
│   │   ├── match.ts                coleta na página de partida
│   │   ├── my-matches.ts           coleta do histórico + motor da varredura
│   │   ├── lobby.ts                selos de reencontro na lobby
│   │   ├── profile.ts              cartão no perfil do jogador
│   │   └── shared/
│   │       ├── selectors.ts        TODO o conhecimento sobre o layout da GC
│   │       ├── parser.ts           extração pura (HTML | JSON) -> MatchRecord
│   │       ├── gc-api.ts           adaptador do JSON /lobby/match/<id>/1
│   │       ├── collect.ts          orquestra coleta -> mensagem ao SW
│   │       └── dom.ts              espera de render (MutationObserver)
│   ├── db/                         schema, migrações e repositório (IndexedDB)
│   ├── lib/                        idb, mensagens, throttle, Result, log
│   ├── ui/                         selo (Shadow DOM) e página de opções
│   ├── config/constants.ts         throttle mínimo, hosts permitidos
│   └── icons/                      ícones 16/32/48/128
├── tests/                          Vitest (parser, repo, migrações, throttle, backfill)
├── tools/                          geração de ícone e sonda de reconhecimento
├── build.mjs                       build esbuild
├── package.mjs                     zip de publicação
├── PUBLICAR.md                     checklist e textos da Chrome Web Store
├── PRIVACIDADE.md                  política de privacidade (publicada no GitHub Pages)
└── RECON.md                        reconhecimento do site: rotas, seletores, APIs
```

## Arquitetura

```
 página da GC                           extensão
┌────────────────────┐   mensagem   ┌─────────────────────────┐
│ content scripts    │ ───────────▶ │ service worker          │
│ match / my-matches │              │  └ IndexedDB            │
│ lobby / profile    │ ◀─────────── │    (origem da extensão) │
└────────────────────┘  reencontros └────────────┬────────────┘
                                                 │
                                     ┌───────────▼───────────┐
                                     │   página de opções    │
                                     └───────────────────────┘
```

- **O banco vive na origem da extensão**, não na da GamersClub. Content scripts gravam
  por mensagem ao service worker. Se gravassem direto, o histórico ficaria no banco
  do site — visível para ele e apagável por uma limpeza de dados dele.
- **Fonte primária de dados:** o JSON da própria GC (`/lobby/match/<id>/1`). O HTML
  renderizado é o plano B. O adaptador aceita partida com substituições, jogador
  listado nos dois times e nick ausente; só reprova sem jogador legível ou sem data.
- **`saveMatch` é idempotente.** A mesma partida vista duas vezes não conta duas vezes.
- **Consultas rápidas:** `getEncounters` responde por contadores desnormalizados em
  `players`, recalculados a cada escrita. Teste de desempenho: 10 jogadores contra um
  banco de 2000 partidas e 5000 jogadores, **< 50 ms**.
- **Agregador e mapas** são calculados na hora a partir de `matchPlayers` + `matches`,
  sem contador novo nem migração.
- **Falhas visíveis:** partida que sai da fila sem virar registro vai para
  `backfill.failed` com o motivo, e o painel oferece **Tentar de novo** só para elas.

## Regras que o código respeita

Vindas das Regras de Conduta da GamersClub, e não negociáveis:

- **Somente leitura.** Nenhum clique, submit, ready, aceite ou avaliação é disparado.
- **Nada toca no CS2.** Sem memória, sem arquivo, sem demo, sem console do jogo.
- **Sem interceptar comunicação.** O WebSocket da plataforma não é tocado.
- **Sem burlar proteção.** As requisições saem da própria aba autenticada, mesma
  origem, sem header forjado.
- **Throttle no código.** Piso de 2500 ms entre requisições da varredura, sequencial,
  configurável só para cima. Para sozinha após 3 falhas seguidas.
- **Sem credenciais.** A extensão não lê, não guarda e não transmite cookie de sessão
  nem token.
- **Zero rede externa.** `isAllowedUrl` bloqueia qualquer fetch fora de
  `gamersclub.com.br` / `cs.gamersclub.gg`.
- **Permissões mínimas.** `storage`, `alarms` e host permissions da GC. Sem `tabs`,
  sem `<all_urls>`, sem `webRequest`.

## Manutenção: quando a GC muda o site

1. A coleta para e nada é gravado pela metade.
2. A falha vai para `meta.lastFailure` (URL, horário, etapa, motivo).
3. A página da extensão mostra o aviso com a data.
4. Conserto:
   1. abra a página afetada logado, com o DevTools aberto;
   2. cole [tools/recon-capture.js](tools/recon-capture.js) no console e rode
      `__gcRecon('match')` (só lê o DOM já baixado);
   3. salve o HTML em `tests/fixtures/` com o `.expected.json` correspondente;
   4. ajuste [src/content/shared/selectors.ts](src/content/shared/selectors.ts);
   5. `npm test`.

O que já foi descoberto sobre rotas, seletores e APIs está em [RECON.md](RECON.md).

## Publicando na Chrome Web Store

O checklist completo, com textos prontos para colar, está em **[PUBLICAR.md](PUBLICAR.md)**.
Resumo do que falta, na ordem:

1. **Conta de desenvolvedor** — <https://chrome.google.com/webstore/devconsole>,
   US$ 5, pagamento único.
2. **Gerar o pacote** — `npm run package` → `releases/gc-encounters-<versão>.zip`.
3. **Screenshots** — pelo menos 1, ideal 3 a 5, em **1280×800 PNG** (lobby com selos,
   painel de partidas, cartão no perfil, página da extensão).
4. **Painel da loja** — *Novo item* → subir o zip → preencher listagem, propósito
   único, formulário de privacidade e justificativas (tudo em PUBLICAR.md §5 e §6).
5. **Política de privacidade** — colar
   `https://robertorneto.github.io/gc-encounters/PRIVACIDADE.html`.
6. **Visibilidade** — *Não listada* para mandar aos amigos (revisão mais rápida) ou
   *Pública*.
7. **Enviar para revisão.**

Para lançar uma atualização: suba a `version` em `src/manifest.json` e em
`package.json`, rode `npm run package` e envie o novo zip no mesmo item. A loja recusa
versão igual ou menor que a publicada.

## Privacidade

A extensão **não coleta, não transmite e não vende dados**. Tudo fica no IndexedDB do
seu navegador e some com **Apagar tudo** ou com a desinstalação.
Política completa: [PRIVACIDADE.md](PRIVACIDADE.md).

---

<sub>Projeto independente, sem vínculo com a GamersClub ou a Valve.</sub>
