# Publicar na Chrome Web Store

Checklist do que falta, na ordem. O que está pronto está marcado.

- [x] Build reproduzível (`npm run package` → `releases/gc-encounters-<versão>.zip`)
- [x] Sem código remoto (exigência dura da MV3 — tudo é bundle local)
- [x] Sem coleta de dados remota
- [x] Ícones 16/32/48/128
- [x] Ícone sem marca de terceiros (anel laranja gerado por código)
- [x] Descrição do manifest ≤ 132 caracteres (122)
- [x] Política de privacidade publicada numa URL (GitHub Pages, ver §7)
- [x] Textos da listagem e justificativas prontos para colar (§5 e §6)
- [ ] **Você:** conta de desenvolvedor (US$ 5, pagamento único)
- [ ] **Você:** screenshots 1280×800 (exigem sua sessão logada na GC)
- [ ] **Você:** preencher o painel e enviar para revisão (§8)

---

## 1. Ícone ✅

Resolvido. O ícone original usava o logo do Chrome e escudos de Major/CS2 — marcas
de terceiros, reprovação certa. Foi trocado pelo anel laranja desenhado por
`node tools/make-icons.mjs`, sem marca nenhuma. A arte antiga fica fora do pacote e
fora do git (`src/icons/source.jpg` está no `.gitignore`).

## 2. Conta

<https://chrome.google.com/webstore/devconsole> → US$ 5, uma vez, vale para sempre.
Use uma conta Google que você não vá perder: ela é dona da extensão.

## 3. Decidir a visibilidade

| Visibilidade | Quem acha | Revisão |
|---|---|---|
| **Não listada** | só quem tem o link | mais rápida, costuma sair em 1-3 dias |
| **Pública** | busca da loja | mais rigorosa |

Para mandar aos amigos, **não listada** entrega o mesmo resultado com menos atrito.

## 4. Screenshots (mínimo 1, ideal 3-5)

1280×800 PNG. Sugestão do que mostrar:

1. lobby com os selos de reencontro sobre os avatares
2. painel aberto com a lista de partidas em comum e o percentual de vitória
3. cartão no perfil de um jogador
4. página da extensão com os contadores e o ranking

Cuidado: os nicks e ids de outros jogadores aparecem nas capturas. São dados
públicos da GC, mas se preferir, borre os nicks.

## 5. Textos para colar

**Nome:** GC Encounters

**Descrição curta (132 caracteres):**

> Mostra quantas vezes você já cruzou com cada jogador da GamersClub, direto na
> lobby, no perfil e na tela de partida.

**Descrição completa:**

> Você entra na lobby e tem a impressão de já ter jogado com aquele cara. A
> GamersClub não responde isso em lugar nenhum.
>
> O GC Encounters registra os jogadores das suas partidas e mostra, no momento em
> que importa, quantas vezes vocês já se cruzaram — quantas contra, quantas no
> mesmo time, quando foi a última e qual seu aproveitamento nessas partidas.
>
> • Selo discreto ao lado de cada jogador já visto antes. Quem você nunca
>   encontrou não mostra nada: ruído zero.
> • Clique no selo para ver as partidas em comum, com mapa, placar e resultado.
> • Cartão no perfil do jogador com o resumo do histórico de vocês.
> • Varredura do seu histórico para popular a base, respeitando um intervalo
>   mínimo de 2,5 s entre requisições.
> • Anotação livre por jogador.
> • Exportação e importação do banco em JSON.
>
> Tudo fica na sua máquina. Sem conta, sem servidor, sem telemetria: a extensão
> não envia nada para lugar nenhum, e só conversa com gamersclub.com.br.
>
> A extensão é somente leitura. Ela não clica, não aceita partida, não dá ready,
> não avalia jogador e não toca no CS2 — nem no processo, nem na memória, nem nos
> arquivos do jogo. Ela lê as mesmas páginas que você já está vendo, na sua
> própria sessão.

**Categoria:** Esportes (ou Ferramentas)

**Propósito único** (a loja exige a declaração):

> Mostrar ao usuário o histórico de partidas em comum entre ele e os outros
> jogadores da GamersClub.

## 6. Formulário de privacidade

Marque **"Não coleto dados do usuário"**. É verdade, e dá para sustentar:
nenhum `fetch` sai para fora de `gamersclub.com.br`, nada é enviado a servidor
nosso (não existe servidor nosso), e o banco é IndexedDB local.

Justificativas, campo a campo:

**`storage`**
> Guarda localmente o histórico de partidas coletado e as preferências do usuário
> (id do jogador, intervalo entre requisições). Nada sai do dispositivo.

**`alarms`**
> A varredura do histórico é retomada periodicamente. O service worker do MV3 é
> encerrado quando ocioso, e o alarme é o que permite continuar de onde parou sem
> exigir que o usuário mantenha uma aba aberta.

**Host permissions `gamersclub.com.br`, `*.gamersclub.com.br` e `cs.gamersclub.gg`**
> A extensão lê as páginas de partida, de histórico e de lobby do site para
> identificar os jogadores das partidas do próprio usuário, e desenha o contador
> de reencontros sobre essas páginas. O curinga `*.gamersclub.com.br` cobre os
> subdomínios da própria GamersClub para onde o site redireciona (como `www.`).
> Nenhum domínio fora da GamersClub é acessado.

**Código remoto:** não. Todo o JavaScript vai no pacote.

## 7. Política de privacidade ✅

Publicada via GitHub Pages a partir de [PRIVACIDADE.md](PRIVACIDADE.md):

**<https://robertorneto.github.io/gc-encounters/PRIVACIDADE.html>**

Cole essa URL no campo "Política de privacidade" do painel. Editou o
`PRIVACIDADE.md` e deu push? A página se atualiza sozinha em ~1 minuto.

## 8. Submeter

1. `npm run package`
2. No painel: novo item → subir `releases/gc-encounters-<versão>.zip`
3. Preencher listagem, privacidade e justificativas
4. Enviar para revisão

Para atualizar depois: suba a `version` em `src/manifest.json`, rode
`npm run package` de novo e envie o novo zip no mesmo item. A loja recusa zip com
versão igual ou menor que a publicada.

## 9. Antes de apertar o botão

Duas coisas que valem uma decisão consciente, não uma descoberta depois:

**Regras da GamersClub.** As Regras de Conduta proíbem programas de terceiros que
interajam com o jogo, interceptem a comunicação com os servidores ou leiam memória
do CS2. Nada disso acontece aqui: a extensão vive no navegador, sobre o site, e
nem toca no WebSocket da plataforma. Extensões parecidas (Booster, Challenger)
existem publicamente há anos. Mesmo assim, publicar torna o projeto visível e
nominal — e a varredura roda em segundo plano, o que de fora parece mais
automação do que navegação. Se a GC decidir implicar, é com o seu nome na vitrine.

**Dado de terceiro.** Hoje cada usuário coleta só o que passa pela conta dele, na
máquina dele. Isso mantém o projeto fora da discussão de LGPD. Se um dia surgir um
backend agregando as bases, a natureza jurídica muda — e essa decisão precisa ser
tomada de propósito, não por acidente de arquitetura.
