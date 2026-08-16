# GlassBank 🏦

Um **simulador bancário educacional** com uma economia totalmente simulada.

O GlassBank funciona como uma aplicação web client-side usando **Firebase Authentication + Firestore**, sem necessidade de build ou backend próprio.

## ✨ Principais recursos

- 🔐 **Conta e autenticação** — cadastro, login e PIN de segurança.
- 💸 **Pix** — enviar, cobrar e pagar usando QR Code.
- 🏦 **Cofre** — sistema de poupança com rendimento.
- 💰 **Empréstimos** — limite baseado no score de crédito.
- 💵 **Caixa eletrônico** — saque e depósito de dinheiro.
- 🧾 **Contas** — água, luz e internet, com vencimento, impostos e multas.
- 📊 **Score de crédito** — de 0 a 1000, influenciado pelo comportamento financeiro.
- 📈 &#x2A;*Bolsa GlassCoin (GLS)** — compra, venda e histórico de preços.
- 📜 **Extrato** — histórico de transações com exportação para CSV e impressão em PDF.
- 🏛️ **Prefeitura** — impostos, recompensas, investimentos e ferramentas administrativas.
- 🌙 **Tema claro/escuro** — com suporte a preferência do sistema.
- 📱 **Interface responsiva** — funciona em computadores e dispositivos móveis.

## 🛠️ Tecnologias

- **HTML + CSS + JavaScript** puro
- **Firebase v9** — Authentication e Firestore
- **Glassmorphism** — interface
- **Font Awesome 7**
- **Google Fonts** — Syne + Figtree
- **html5-qrcode 2.3.8** — geração e leitura de QR Codes

O projeto utiliza hospedagem estática, como **Firebase Hosting**, e não precisa de processo de build.&#x20;

## 🚀 Como executar

O projeto precisa ser executado através de um servidor HTTP. Abrir o `index.html` diretamente com `file://` não funciona por causa dos módulos ES.

### Opção 1 — Node.js

```bash
npx serve .
```

### Opção 2 — Python

```bash
python -m http.server 8080
```

Depois, acesse:

```text
http://localhost:8080
```

## 🔥 Configurando o Firebase

Para utilizar seu próprio projeto Firebase:

1. Crie um projeto no **Firebase Console**.
2. Ative **Authentication → Email/Password**.
3. Ative o **Cloud Firestore**.
4. Copie sua configuração `firebaseConfig`.
5. Adicione-a ao `index.html`.

## 📁 Estrutura

```text
index.html   → Estrutura da aplicação
style.css    → Estilos, temas, responsividade e animações
script.js    → Lógica principal do GlassBank
```

A aplicação é executada principalmente no cliente, utilizando transações do Firestore para sincronizar operações da economia simulada. fileciteturn0file0L39-L44

## 📱 Compatibilidade

Funciona em:

- Chrome
- Firefox
- Edge
- Safari

Também possui interface adaptada para **desktop e mobile**. O leitor de QR Code requer acesso à câmera (`getUserMedia`). fileciteturn0file0L128-L133

## ⚠️ Limitações

- Transações não podem ser estornadas.
- O scanner QR precisa de uma câmera.
- A atualização da bolsa depende das permissões de escrita no Firestore.
- Recursos administrativos são restritos a contas autorizadas.
- O projeto ainda **não é um PWA** e não possui funcionamento offline. fileciteturn0file0L180-L185

## 📚 Objetivo

O GlassBank foi desenvolvido como um **projeto educacional**, permitindo experimentar conceitos de:

- Economia
- Bancos digitais
- Impostos
- Crédito
- Investimentos
- Transações
- Desenvolvimento web
- Firebase

## 📄 Licença

**Projeto privado — uso educacional.**
