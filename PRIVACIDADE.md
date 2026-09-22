# Política de Privacidade — GC Encounters

Última atualização: 22 de setembro de 2026

## Resumo

O GC Encounters **não coleta, não transmite e não vende dados**. Não existe
servidor do outro lado: tudo o que a extensão guarda fica no seu navegador, na sua
máquina.

## O que a extensão armazena

Localmente, no IndexedDB do seu navegador:

- **Partidas suas** na GamersClub: identificador, data, mapa, placar e resultado.
- **Jogadores** dessas partidas: id da GamersClub, apelido, nível e o time em que
  cada um jogou.
- **Configurações:** seu id de jogador, o intervalo entre requisições e o progresso
  da varredura do histórico.
- **Anotações** que você mesmo escrever sobre um jogador.

Esses dados vêm das mesmas páginas e respostas que o site já entrega ao seu
navegador quando você está logado.

## O que a extensão NÃO faz

- Não envia dados para servidores próprios ou de terceiros. Não há telemetria,
  analytics, rastreamento ou webhook.
- Não lê, não armazena e não transmite cookies, senhas ou tokens de sessão. As
  requisições saem do seu próprio navegador, com a sessão que ele já tem.
- Não acessa nenhum site além de `gamersclub.com.br` e `cs.gamersclub.gg`. A página
  da extensão carrega avatares e ícones de nível dos mesmos servidores da
  GamersClub (`static.gamersclub.com.br` e `gcv1-assets.gamersclub.com.br`), como
  o próprio site faz.
- Não interage com o jogo Counter-Strike 2: não lê memória, não lê arquivos do
  jogo, não intercepta comunicação com servidores de partida.
- Não executa ação nenhuma na plataforma em seu nome: não clica, não aceita
  partida, não dá ready, não avalia jogadores.

## Permissões e por quê

- **`storage`** — guardar o histórico coletado e suas preferências no dispositivo.
- **`alarms`** — retomar a varredura do histórico depois que o navegador encerra o
  processo em segundo plano da extensão.
- **Acesso a `gamersclub.com.br` e `cs.gamersclub.gg`** — ler as páginas de
  partida, histórico e lobby para identificar os jogadores das suas partidas, e
  desenhar o contador de reencontros sobre essas páginas.

## Dados de outros jogadores

Para dizer "você já jogou 4 vezes contra essa pessoa", a extensão precisa guardar o
id e o apelido dos jogadores das **suas** partidas. São informações que a
GamersClub já exibe publicamente no site.

Esses registros ficam apenas no seu dispositivo, nunca são compartilhados pela
extensão, e desaparecem quando você usa "Apagar tudo" na página da extensão ou
remove a extensão do navegador.

## Seu controle

Na página da extensão você pode, a qualquer momento:

- **Exportar** todo o banco em JSON;
- **Importar** um export anterior;
- **Apagar tudo**, sem deixar resíduo.

Desinstalar a extensão remove o banco junto.

## Alterações

Mudanças nesta política aparecem neste documento, com a data de atualização acima.

## Contato

Dúvidas ou pedidos sobre privacidade: abra uma issue em
<https://github.com/RobertorNeto/gc-encounters/issues>.
