# 🚀 NEXVON FLUENCY — Agente de IA de Vendas para WhatsApp + Painel Administrativo

Sistema completo de atendimento e vendas automáticas no WhatsApp para a **NEXVON FLUENCY**, com agente de IA especializado em vendas, base de conhecimento editável, escalonamento humano e painel administrativo premium em tempo real.

---

## ✨ O que o sistema faz

- 🤖 **Agente de IA de vendas** que atende cada lead no WhatsApp com tom cordial, conhece profundamente a NEXVON FLUENCY (preços, pagamentos, garantia, recursos, +40 idiomas) e conduz o lead até o fechamento.
- 💬 **Contexto por lead**: lembra nome, idioma de interesse, objeções tratadas e histórico completo.
- 🎯 **Estratégia de vendas SPIN**: saudação → qualificação → apresentação → tratamento de objeções → fechamento (incentiva PIX com 10% OFF ou cartão 6x sem juros).
- 🧑‍💼 **Escalonamento humano**: quando a IA não sabe responder ou o cliente pede, direciona automaticamente para **(19) 99704-8175** via `wa.me/5519997048175`.
- 🖥️ **Painel administrativo premium** (tema dark, design moderno) com:
  - Dashboard com estatísticas e gráficos em tempo real
  - Conversas em tempo real (SSE) com **assumir conversa** (human takeover)
  - Gestão de leads (status, tags, idioma, nível)
  - Base de conhecimento / FAQ editável (injetada na IA)
  - System Prompt 100% editável
  - Configuração de LLM (OpenAI, Groq, OpenRouter, qualquer API compatível)
  - Regras de escalonamento configuráveis (palavras-chave)
  - Logs do sistema
  - QR code do WhatsApp exibido no painel para conexão
- 🗄️ Banco de dados SQLite local (sem servidor externo) — `data/nexvon.db`
- 🔌 Funciona **sem chave de API** configurada (modo fallback com mensagem padrão) e **sem WhatsApp conectado** (aguarda QR).

---

## 📋 Pré-requisitos

- **Node.js 18+** (recomendado 20 LTS ou superior)
- Um celular com WhatsApp ativo no número de atendimento (para escanear o QR)
- (Opcional, mas recomendado) Uma chave de API de LLM compatível com OpenAI:
  - OpenAI: https://platform.openai.com/api-keys
  - Groq (mais barato e rápido): https://console.groq.com/keys
  - OpenRouter (vários modelos): https://openrouter.ai/keys

---

## 🚀 Instalação passo a passo

### 1. Descompacte e instale as dependências
```bash
cd nexvon-whatsapp-ai
npm install
```

### 2. Configure as variáveis de ambiente
Copie o arquivo de exemplo e edite:
```bash
cp .env.example .env
```
Edite o `.env` com seus dados:
```env
PORT=3000
ADMIN_PASSWORD=sua_senha_admin_aqui
LLM_API_KEY=sk-... (sua chave, pode deixar vazio pra testar)
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TEMPERATURE=0.7
OWNER_WHATSAPP=5519997048175
```

> 💡 **Dica**: para usar **Groq** (mais rápido e barato), use:
> `LLM_BASE_URL=https://api.groq.com/openai/v1` e `LLM_MODEL=llama-3.3-70b-versatile`

### 3. Inicie o sistema
```bash
npm start
```

### 4. Conecte o WhatsApp
- Abra o navegador em **http://localhost:3000/admin**
- Faça login com a senha definida em `ADMIN_PASSWORD`
- Vá na aba **WhatsApp** — um **QR code** aparecerá
- No celular do número de atendimento: WhatsApp → Aparelhos conectados → Conectar aparelho → escaneie o QR
- Quando ficar **verde "Conectado"**, o sistema está no ar!

### 5. (Opcional) Configure a IA
Na aba **Configurações da IA**, cole sua chave de API, escolha modelo e temperatura, e ajuste o System Prompt se quiser. Salve. Pronto — o agente passa a responder com IA.

---

## 🖥️ Como usar o painel

| Aba | Função |
|-----|--------|
| **Dashboard** | Visão geral: leads, mensagens hoje, fechamentos, gráficos |
| **Conversas** | Veja e responda conversas em tempo real. Clique em "Assumir conversa" para pausar a IA e responder você mesmo. |
| **Leads** | Gerencie status, tags, idioma de interesse e nível de cada lead |
| **Base de Conhecimento** | Adicione/edite FAQs que a IA usa para responder (preços, regras, etc.) |
| **Configurações da IA** | Edite System Prompt, chave de API, modelo, temperatura |
| **Escalonamento** | Defina palavras-chave que disparam atendimento humano |
| **Logs** | Acompanhe erros e eventos do sistema |
| **WhatsApp** | Status da conexão, QR code, reconectar/desconectar |

---

## 🧠 Como o agente de vendas funciona

1. **Recebe mensagem** → identifica lead (telefone), salva no banco.
2. **Verifica takeover** → se você assumiu a conversa, a IA não responde.
3. **Verifica escalonamento** → se a mensagem contém palavras-chave (ex: "falar com humano", "reembolso"), responde com o link do atendente humano.
4. **Chama a LLM** → envia System Prompt (todo o conhecimento do produto + estratégia de vendas) + Base de Conhecimento + histórico da conversa.
5. **Envia a resposta** no WhatsApp e salva no histórico.
6. **Fallback** → se não houver chave de API ou a LLM falhar, envia mensagem padrão com link de pagamento e contato humano.

O **System Prompt** já vem pré-configurado com todos os fatos da NEXVON FLUENCY (preços R$496,52 no PIX, 6x R$91,95, garantia 7 dias, +40 idiomas, Aria, PhrasePump, etc.) e estratégia de fechamento. Você pode editar tudo no painel.

---

## 🔐 Segurança

- O painel é protegido por senha (`ADMIN_PASSWORD`).
- A chave de API da LLM é armazenada localmente no SQLite e nunca é exposta (o painel mostra apenas versão mascarada).
- Recomendado rodar atrás de proxy reverso com HTTPS (ex: Nginx + Let's Encrypt) se expor na internet.

---

## 🛠️ Estrutura do projeto

```
nexvon-whatsapp-ai/
├── package.json
├── .env.example
├── README.md
├── API_CONTRACT.md
├── src/
│   ├── server.js          # Servidor Express + API REST + SSE
│   ├── config.js          # Carrega variáveis de ambiente
│   ├── db.js              # Banco SQLite + schema + seed
│   ├── llm.js             # Cliente LLM compatível com OpenAI
│   ├── whatsapp.js        # Integração Baileys (conexão WhatsApp)
│   ├── agent.js           # Lógica do agente de vendas
│   └── agentSystemPrompt.js # System Prompt padrão (pré-configurado)
├── public/                # Painel administrativo (SPA servido em /admin)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
└── data/                  # Banco SQLite + sessão do WhatsApp (criado automaticamente)
```

---

## ❓ Perguntas frequentes

**P: Preciso pagar a API oficial do WhatsApp Business?**
R: Não. O sistema usa a biblioteca Baileys (conexão via QR code, como o WhatsApp Web). Basta um celular com WhatsApp comum.

**P: Funciona sem chave de IA?**
R: Sim. Ele responde com uma mensagem padrão de boas-vindas + link de pagamento + contato humano. Para respostas inteligentes, adicione uma chave de LLM.

**P: Meus dados ficam onde?**
R: Tudo local, no arquivo `data/nexvon.db`. Nenhum dado vai para servidores terceiros além da LLM que você escolher (apenas o histórico da conversa é enviado para a LLM gerar resposta).

**P: Como atualizo preços ou informações?**
R: Na aba **Base de Conhecimento** (FAQ) e no **System Prompt** (aba Configurações da IA). A IA passa a usar as informações novas imediatamente.

**P: O WhatsApp desconectou?**
R: Vá na aba WhatsApp, clique em **Reconectar** e escaneie o QR novamente. A sessão fica salva em `data/baileys_auth/`, então normalmente reconecta sozinho.

---

## 📞 Suporte

Dúvidas técnicas? O sistema foi construído para ser simples de rodar. Se algo der errado, verifique os **Logs do Sistema** no painel — eles indicam exatamente o que falhou (falta de chave de API, WhatsApp desconectado, etc.).

---

**Feito com 💙 para a NEXVON FLUENCY** — feche mais vendas no automático.
