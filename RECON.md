# RECON — Fase 0

**Status: página de partida VERIFICADA (21/09/2026). Histórico e lobby pendentes.**

Reconhecimento feito com sessão logada, via sondas no console (veja
[tools/recon-capture.js](tools/recon-capture.js)). Só leitura do DOM já carregado:
nenhuma requisição nova, nenhum clique, nenhum cookie tocado.

---

## 1. URLs reais

| O que | Rota real | Confirmado |
|---|---|---|
| Perfil do jogador | `gamersclub.com.br/player/<id>` | ✅ |
| Partida finalizada | `gamersclub.com.br/lobby/partida/<id>` | ✅ |
| Histórico | `gamersclub.com.br/my-matches` | ✅ |
| Lobby / vetos | — | ☐ |

Chutes originais que estavam **errados**: `/jogador/<id>`, `/partida/<id>`,
`/minhas-partidas`. O manifest foi corrigido para as rotas reais.

## 2. Origem dos dados — página de partida

**HTML renderizado.** Não há endpoint JSON com o elenco.

- `hasNextData: false`, nenhum `data-*` no markup relevante
- as chamadas XHR da página são de anúncio, amizade, token, highlights e
  `/api/game/<id>/room/recreate/status` — nenhuma traz os 10 jogadores
- existe WebSocket na página. **Não é tocado**: interceptar comunicação com os
  servidores da GC é o que as Regras de Conduta proíbem

Ou seja: parser de HTML, frágil por necessidade, com falha explícita quando não achar.

### Seletores confirmados

| Campo | Seletor | Como extrair |
|---|---|---|
| Bloco de time | `table.PlayerStatsTable` | exatamente 2, 5 jogadores cada; ordem = time A, time B |
| Linha do jogador | `tr.PlayerStatsLine` | |
| Nick + id | `a.PlayerStatsProfile__nickname` | id vem do `href` (`/player/<id>`) |
| Nível | `span[class*="gcf-badge-level-"]` | número está na **classe** (`gcf-badge-level-16`) |
| Mapa | `img.MatchResultInfo__map` | atributo `alt` (`de_cache`) |
| Placar | `.MatchResultInfo__scoreBox` | texto `13vs8` |
| Data | `p.MatchResultInfo__blockText` | `21/09/2026 00:26`; o rótulo "DATA" não é marcado, então o parser fica com o primeiro bloco que parseia como data |

Bloco de informações completo, para referência do dia:

```
Time Rick Lee | 13 | vs | 8 | Time dublex | DATA | 21/09/2026 00:26 |
DURAÇÃO | 41 Minutos | ID DA PARTIDA | 27915278 | MAPA | de_cache |
TIPO | Competitivo | STATUS | Finalizado | FORMATO | MD1
```

## 3. Identificador estável

✅ `/player/<id>` no href do nick, em todas as linhas. Os 10 jogadores da partida
`27915278` saíram com id, nick e nível. O próprio usuário (`1885415`) aparece na
lista, então dá para classificar contra/junto.

Detecção automática do "meu id": `/api/v1/user/me` existe e é chamado pela própria
página. Hoje o id é definido à mão na página de opções — mais simples e sem
requisição extra.

## 3b. Assets públicos (usados pela página de opções)

Descobertos em 22/09/2026 a partir de código público de outras extensões da
comunidade (gamersclub-booster, gamersclub-challenger) e confirmados com `curl`
sem sessão. A home da GC devolve 403 para clientes sem navegador; os assets não.

| O que | URL | Notas |
|---|---|---|
| Avatar do jogador | `https://static.gamersclub.com.br/players/avatar/<id>/<id>_medium.jpg` | também `_full.jpg`; id desconhecido devolve avatar padrão (200) |
| Ícone de nível | `https://gcv1-assets.gamersclub.com.br/assets/images/level/<n>.svg` | `n` de 0 a 21; é o fundo do `.gcf-new-badge-level-<n>` |
| Cores de nível | `.gcf-badge-level-<n>` no CSS da GC | tabela copiada em `src/ui/options.ts` (`LEVEL_COLORS`), fallback se o SVG falhar |

## 3c. Kills e deaths (K/D)

✅ **Confirmado em uso (22/09/2026):** o bloco de stats de `jogos.players.team_x` em
`/lobby/match/<id>/1` traz kills e deaths em um dos nomes aceitos pelo adaptador
(`nb_kill`/`nb_death` em primeiro lugar; depois `nb_kills`/`nb_deaths`,
`kills`/`deaths`, `kill`/`death`, `k`/`d`). Partidas coletadas depois da mudança
passaram a exibir K/D nas opções. Sem os dois campos, o K/D fica ausente, nunca
inventado. Partidas gravadas antes do campo existir não têm K/D: a varredura pula
partida conhecida, então só "Apagar tudo" + nova varredura preenche o histórico.

## 4. Paginação do histórico

☐ Pendente. Rota é `/my-matches`; falta saber se pagina por query param, scroll
infinito ou botão, e quantas partidas cabem por página.

## 5. Timing de render

☐ Pendente medir. A página é Vue (`app.js` + `chunk-vendors.js`), então o conteúdo
entra depois do `document_end` — o content script já usa `MutationObserver` e espera
o primeiro link de jogador aparecer, com desistência em 20 s.

---

## Fixtures capturados

| Arquivo | Página | Data | Notas |
|---|---|---|---|
| — | partida 27915278 | 21/09/2026 | seletores extraídos por sonda; HTML ainda não salvo |

Pendente: salvar o HTML da partida em `tests/fixtures/match-27915278.html` + o
`.expected.json` correspondente, para os testes de parser saírem do modo pendente.
