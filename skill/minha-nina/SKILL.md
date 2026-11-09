---
name: minha-nina
description: Cria do zero a "Minha Nina" da pessoa — o WhatsApp dela conectado ao Claude (ver conversas, ler e responder clientes pedindo no chat). Monta sozinha o servidor no Render, mostra o QR code e entrega o link do conector. Use quando a pessoa digitar /minha-nina, pedir para "conectar meu WhatsApp no Claude", "criar minha Nina", ou quiser atualizar, reconectar ou ver o status da Nina dela (/minha-nina atualizar | reconectar | status).
---

# Minha Nina — instalação guiada

Você vai criar, para uma pessoa **sem conhecimento técnico**, um servidor que liga o WhatsApp dela ao Claude.
Ela não sabe o que é API, servidor ou terminal. Fale em português simples, frases curtas, um passo de cada vez.
**Você executa tudo** (comandos, chamadas à API, abrir o navegador). Ela só: cria a conta no Render, cola a chave
e lê o QR code com o celular.

## Regras
- Peça **uma coisa por vez** e espere a resposta.
- Nunca mostre comandos, JSON ou mensagens de erro técnicas. Traduza: "a chave não funcionou", "falta o cartão".
- A chave do Render (começa com `rnd_`) e a senha do conector são segredos: **não grave em arquivo**, não repita
  na tela depois de usar, guarde só em variável durante a conversa.
- Use `curl` para a API (no Windows o Claude Code costuma rodar no Git Bash, onde `curl` e `openssl` existem). Se não houver bash nem curl, faça as mesmas chamadas pelo PowerShell com `Invoke-RestMethod` (cabeçalho `Authorization: Bearer CHAVE`, corpo com `ConvertTo-Json -Depth 6`).
- Programa instalado: repositório público `https://github.com/robertomanfroi/minha-nina` (não precisa de conta no GitHub).

## Sub-comandos
- `/minha-nina` → instalação completa (abaixo).
- `/minha-nina status` → peça a chave do Render, ache o serviço que começa com `minha-nina`, consulte `/status/<TOKEN>` e diga em uma frase se está conectado.
- `/minha-nina reconectar` → peça a chave, ache o serviço e a variável `TOKEN` (`GET /v1/services/{id}/env-vars`) e abra a página `/conectar/<TOKEN>`.
- `/minha-nina atualizar` → peça a chave, ache o serviço e faça `POST /v1/services/{id}/deploys` com `{"clearCache":"clear"}`. Acompanhe até `live`. Avise que o WhatsApp continua conectado.

---

## Passo 0 — Combinar
Explique em até 6 linhas:
- O que ela vai ter: no Claude, pedir "me mostre as conversas esperando resposta", "responda a Maria", "mande no grupo X".
- O Claude **não responde sozinho**: só age quando ela pede no chat.
- Custo: o servidor no Render custa **cerca de US$ 7,50 por mês** (cobrado no cartão dela, em dólar).
- Cuidado: é uma conexão não oficial. Mandar mensagem em massa ou para quem não tem o número dela salvo pode fazer o
  WhatsApp **bloquear o número**. Melhor usar com clientes que já conversam com ela.
Pergunte: "Podemos começar?"

## Passo 1 — Conta no Render
1. Abra no navegador: `https://dashboard.render.com/register` (Windows: `start ""`; Mac: `open`; Linux: `xdg-open`).
2. Diga: "Crie sua conta (pode entrar com o Google). Quando aparecer o painel do Render, me avise."
3. Depois abra `https://dashboard.render.com/billing` e diga: "Cadastre um cartão de crédito em **Payment Information**
   (sem cartão o Render não deixa criar o servidor). Me avise quando terminar."

## Passo 2 — Chave do Render
1. Abra `https://dashboard.render.com/u/settings#api-keys`.
2. Diga: "Clique em **Create API Key**, dê o nome *minha-nina*, clique em **Create** e **copie a chave** (começa com `rnd_`). Cole aqui para mim."
3. Teste: `curl -s -H "Authorization: Bearer $CHAVE" https://api.render.com/v1/owners?limit=20`.
   - 401 → "A chave não funcionou. Copie de novo, inteira." Volte ao 2.
   - Guarde o `owner.id`. Conta nova costuma ter um só ("My Workspace"); se houver mais de um, pergunte em qual workspace criar, mostrando os nomes.

## Passo 3 — Já existe?
`GET /v1/services?name=minha-nina&limit=20`. Se já houver um serviço `minha-nina`, não crie outro: pergunte se ela quer
**reconectar** (vá ao Passo 6 com o TOKEN dele) ou **atualizar**.

## Passo 4 — Criar o servidor
1. Gere a senha do conector: `openssl rand -hex 24` (sem openssl: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`;
   PowerShell: `-join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) })`). Guarde em `TOKEN`.
2. Crie (troque OWNER e TOKEN):
```bash
curl -s -X POST https://api.render.com/v1/services \
  -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" \
  -d '{
    "type": "web_service",
    "name": "minha-nina",
    "ownerId": "OWNER",
    "repo": "https://github.com/robertomanfroi/minha-nina",
    "branch": "main",
    "autoDeploy": "no",
    "envVars": [
      {"key": "TOKEN", "value": "TOKEN"},
      {"key": "DATA_DIR", "value": "/data"},
      {"key": "NODE_VERSION", "value": "22"}
    ],
    "serviceDetails": {
      "runtime": "node",
      "plan": "starter",
      "region": "oregon",
      "healthCheckPath": "/saude",
      "disk": {"name": "dados", "mountPath": "/data", "sizeGB": 1},
      "envSpecificDetails": {"buildCommand": "npm ci", "startCommand": "npm start"}
    }
  }'
```
3. Guarde `service.id` e `service.serviceDetails.url` (o endereço, ex.: `https://minha-nina-abcd.onrender.com`).
   - Erro falando de pagamento/cartão → volte ao Passo 1.3.
   - Erro de nome já usado → tente `"name": "minha-nina-2"`.
4. Diga: "Estou montando o seu servidor. Leva uns 5 minutos."
5. A cada 20 s, `GET /v1/services/{id}/deploys?limit=1` até `deploy.status` = `live` (máx. 15 min).
   - `build_failed` / `update_failed` → tente de novo uma vez (`POST /v1/services/{id}/deploys`). Se falhar de novo, diga que
     houve um problema no servidor e peça para ela mandar um print desta conversa para quem passou a skill.

## Passo 5 — Conectar o WhatsApp
1. Abra no navegador: `URL/conectar/TOKEN`.
2. Diga: "No celular, abra o WhatsApp → **Aparelhos conectados** → **Conectar aparelho** e aponte a câmera para o
   código na tela. (Se estiver no celular, use a opção 'Está abrindo esta página no próprio celular?')"
3. A cada 10 s, `GET URL/status/TOKEN` até `"conectado": true` (máx. 10 min). Se `parado` = true, leia o `erro` e explique.
4. Comemore: "✅ WhatsApp conectado!"

## Passo 6 — Ligar no Claude
1. Monte o link do conector: `URL/mcp/TOKEN`. Mostre **uma vez**, num bloco para copiar.
2. Explique, em passos numerados:
   1. Abra **claude.ai** (no computador) → clique no seu nome → **Configurações** → **Conectores**.
   2. **Adicionar conector personalizado**. Nome: *Minha Nina* (ou o que quiser). URL: cole o link. **Adicionar**.
   3. Num **chat novo**, clique no **+** embaixo da caixa de texto e confirme que *Minha Nina* está ligado.
   4. Peça: "Minha Nina, me mostre as conversas que estão esperando resposta".
3. Avise:
   - "Esse link é a **senha do seu WhatsApp**. Não mande para ninguém. Se vazar, rode `/minha-nina` e peça para trocar a senha."
   - "As conversas aparecem a partir de agora (mais algumas recentes que o celular sincroniza)."
   - "Se um dia parar, rode `/minha-nina reconectar` e leia o QR code de novo."
   - "Para atualizar o programa no futuro: `/minha-nina atualizar`."

## Trocar a senha (se o link vazou)
Gere um TOKEN novo, `PUT /v1/services/{id}/env-vars/TOKEN` com `{"value":"NOVO"}`, depois `POST /v1/services/{id}/deploys`.
Espere `live`, mostre o link novo e explique que ela precisa trocar a URL do conector no Claude.
