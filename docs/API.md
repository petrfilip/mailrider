# MailRider API Documentation

Minimalistická dokumentace HTTP API pro MailRider testovací nástroj.

## Základní info

**Base URL:** `http://localhost:8082`

**Autentizace:** Není potřeba (lokální dev)

---

## HTTP API Endpoints

### 📧 Emaily

#### `GET /api/emails`
Vrátí seznam všech emailů s metadata.

**Response:**
```json
{
  "total": 5,
  "totalSize": 45678,
  "emails": [
    {
      "filename": "1731574200.abc123.mailrider",
      "timestamp": 1731574200,
      "size": 1234,
      "from": "sender@example.com",
      "to": "recipient@faktron.cz",
      "subject": "Test email",
      "preview": "Email body preview...",
      "attachmentCount": 2,
      "isRead": false
    }
  ]
}
```

---

#### `GET /api/emails/:filename/full`
Vrátí kompletní detail emailu včetně těla a příloh.

**Response:**
```json
{
  "filename": "1731574200.abc123.mailrider",
  "messageId": "<abc@example.com>",
  "from": "sender@example.com",
  "to": "recipient@faktron.cz",
  "cc": "copy@example.com",
  "subject": "Test email",
  "date": "2024-11-14T08:30:00.000Z",
  "headers": {
    "received": "from mail.example.com...",
    "content-type": "multipart/mixed"
  },
  "textBody": "Plain text version...",
  "htmlBody": "<html>HTML version...</html>",
  "rawContent": "Raw MIME content...",
  "attachments": [
    {
      "index": 0,
      "filename": "document.pdf",
      "contentType": "application/pdf",
      "size": 5678,
      "contentId": null,
      "isImage": false
    }
  ],
  "isRead": true
}
```

---

#### `POST /api/emails/:filename/read`
Označí email jako přečtený.

**Response:**
```json
{
  "success": true,
  "isRead": true
}
```

---

#### `POST /api/emails/:filename/unread`
Označí email jako nepřečtený.

**Response:**
```json
{
  "success": true,
  "isRead": false
}
```

---

#### `DELETE /api/emails/:filename`
Smaže email.

**Response:**
```json
{
  "success": true
}
```

---

#### `DELETE /api/emails/all`
Smaže všechny emaily.

**Response:**
```json
{
  "success": true,
  "deletedCount": 5
}
```

---

#### `GET /api/emails/:filename.eml`
Stáhne email v .eml formátu (RFC822).

**Response:** Raw email content
**Headers:**
- `Content-Type: message/rfc822`
- `Content-Disposition: attachment; filename="..."`

---

### 📎 Přílohy

#### `GET /api/emails/:filename/attachments/:index`
Stáhne přílohu.

**Response:** Binary content
**Headers:**
- `Content-Type: <attachment-mime-type>`
- `Content-Disposition: attachment; filename="..."`

---

#### `GET /api/emails/:filename/attachments/:index/thumb`
Vrátí thumbnail obrázku (pouze pro obrázky).

**Response:** PNG image (200x200px max)
**Headers:**
- `Content-Type: image/png`
- `Cache-Control: public, max-age=86400`

---

## SMTP API

**Host:** `localhost`
**Port:** `2587`
**TLS:** Ne
**Autentizace:** Ne

**Catch-all:** Přijímá **jakoukoliv** adresu a doménu

**Příklad (curl):**
```bash
curl --url "smtp://localhost:2587" \
  --mail-from "sender@example.com" \
  --mail-rcpt "anyone@anywhere.com" \
  --upload-file email.txt
```

---

## IMAP API

**Host:** `localhost`
**Port:** `143`
**TLS:** Ne
**Credentials:**
- Email: `inbox@mailrider.local`
- Heslo: `test`

**Příklad (Python):**
```python
import imaplib

imap = imaplib.IMAP4('localhost', 143)
imap.login('inbox@mailrider.local', 'test')
imap.select('INBOX')

# Vyhledat všechny emaily
status, messages = imap.search(None, 'ALL')
email_ids = messages[0].split()

# Načíst email
status, msg_data = imap.fetch(email_ids[0], '(RFC822)')
email_body = msg_data[0][1]

imap.close()
imap.logout()
```

---

## Web UI

**URL:** `http://localhost:8082`

**Funkce:**
- 📧 Zobrazení emailů s přečteno/nepřečteno
- 🔵 Modrá tečka u nepřečtených
- 📎 Náhled a stahování příloh
- 🌙 Dark mode
- 🗑️ Mazání emailů
- 💾 Export .eml
- 🔄 Auto-refresh (10s)

---

## Docker API

### Spuštění
```bash
docker-compose up -d mailrider
```

### Logy
```bash
docker logs mailrider -f
```

### Restart
```bash
docker-compose restart mailrider
```

### Zastavení
```bash
docker-compose down
```

---

## Příklady použití

### 1. Odeslat testovací email (curl)

```bash
cat > /tmp/test-email.txt << 'EOF'
From: test@example.com
To: user@anywhere.com
Subject: Test email

This is a test email body.
EOF

curl --url "smtp://localhost:2587" \
  --mail-from "test@example.com" \
  --mail-rcpt "user@anywhere.com" \
  --upload-file /tmp/test-email.txt
```

### 2. Načíst všechny emaily (JavaScript)

```javascript
const response = await fetch('http://localhost:8082/api/emails');
const data = await response.json();

console.log(`Total emails: ${data.total}`);
data.emails.forEach(email => {
  console.log(`${email.subject} - ${email.from}`);
});
```

### 3. Smazat všechny emaily (JavaScript)

```javascript
await fetch('http://localhost:8082/api/emails/all', {
  method: 'DELETE'
});
```

### 4. Stáhnout přílohu (JavaScript)

```javascript
const filename = '1731574200.abc123.mailrider';
const attachmentIndex = 0;

const response = await fetch(
  `http://localhost:8082/api/emails/${filename}/attachments/${attachmentIndex}`
);
const blob = await response.blob();
const url = URL.createObjectURL(blob);

// Stáhnout soubor
const a = document.createElement('a');
a.href = url;
a.download = 'attachment.pdf';
a.click();
```

### 5. E2E test s automatickým čištěním (Jest)

```javascript
beforeEach(async () => {
  // Vyčisti všechny emaily před testem
  await fetch('http://localhost:8082/api/emails/all', {
    method: 'DELETE'
  });
});

test('email je doručen', async () => {
  // Odešli email
  await sendEmail({
    to: 'test@example.com',
    subject: 'Test',
    body: 'Test body'
  });

  // Počkej na doručení
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Ověř doručení
  const response = await fetch('http://localhost:8082/api/emails');
  const data = await response.json();

  expect(data.total).toBe(1);
  expect(data.emails[0].subject).toBe('Test');
});
```

---

## Rate Limits

**Žádné** - jedná se o lokální dev nástroj.

---

## CORS

CORS není nakonfigurován - API je určeno pouze pro localhost.

---

## Error Handling

Všechny endpointy vracejí JSON error v případě chyby:

```json
{
  "error": "Error message"
}
```

HTTP status kódy:
- `200` - Success
- `404` - Not found
- `500` - Server error
