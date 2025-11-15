# MailRider - Quick Start

Rychlý start pro testování emailů v 3 krocích.

---

## 1️⃣ Spuštění

```bash
cd docker/dev
docker-compose up -d mailrider
```

**Běží na:**
- 📧 SMTP: `localhost:2587`
- 📥 IMAP: `localhost:143` (user: `inbox@mailrider.local`, heslo: `test`)
- 🌐 Web UI: http://localhost:8082

---

## 2️⃣ Odeslání testovacího emailu

### Pomocí curl:
```bash
cat > /tmp/test.txt << 'EOF'
From: test@example.com
To: user@anywhere.com
Subject: Test email

This is a test email body.
EOF

curl --url "smtp://localhost:2587" \
  --mail-from "test@example.com" \
  --mail-rcpt "user@anywhere.com" \
  --upload-file /tmp/test.txt
```

### Pomocí test skriptů:
```bash
cd ../../scripts/test-emails
./send-isdoc-email.sh test@example.com
```

---

## 3️⃣ Kontrola emailů

### Web UI (nejjednodušší):
Otevři: http://localhost:8082

### HTTP API:
```bash
curl http://localhost:8082/api/emails | jq
```

### IMAP (Python):
```python
import imaplib

imap = imaplib.IMAP4('localhost', 143)
imap.login('inbox@mailrider.local', 'test')
imap.select('INBOX')
status, messages = imap.search(None, 'ALL')
print(f"Emails: {len(messages[0].split())}")
```

---

## 🧹 Vyčištění

Smazat všechny emaily:
```bash
curl -X DELETE http://localhost:8082/api/emails/all
```

---

## 📚 Další dokumentace

- **[README.md](./README.md)** - Kompletní setup a troubleshooting
- **[API.md](./API.md)** - HTTP/SMTP/IMAP API dokumentace
