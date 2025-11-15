 # MailRider Mail Server

Lokální mail server pro vývoj s univerzální routing podporou.

> **⚠️ BEZPEČNOSTNÍ UPOZORNĚNÍ**
> Tento server je určen **POUZE pro lokální vývoj**:
> - ❌ Žádná autentizace na SMTP
> - ❌ Plaintext credentials na IMAP (`inbox@mailrider.local` / `test`)
> - ❌ Žádné TLS/SSL šifrování
> - ❌ Žádný rate limiting nebo spam prevence
> - ❌ Žádná validace odesílatelů
>
> **🚫 NIKDY nepouštějte tento server na internetu nebo produkčním prostředí!**
> Používejte pouze na `localhost` za firewallem.

**📖 Dokumentace:**
- **[QUICKSTART.md](./QUICKSTART.md)** - Rychlý start v 3 krocích
- **[API.md](./API.md)** - Kompletní API dokumentace s příklady

## Architektura

**Node.js SMTP Server** (port 2587)
- Přijímá SMTP emaily na **JAKOUKOLIV** adresu a doménu (např. `user@example.com`, `test@faktron.cz`, `admin@localhost`)
- Všechny routuje do jednoho MailRider účtu: `inbox@mailrider.local`
- Ukládá do Maildir formátu

**Dovecot IMAP Server** (port 143)
- Čte z Maildir
- Poskytuje standardní IMAP4rev1 rozhraní
- Autentizace: `inbox@mailrider.local` / `test`

## Použití

### Spuštění

```bash
cd docker/dev
docker-compose up mailrider
```

### Odeslání testovacího emailu

```bash
# Server přijímá JAKOUKOLIV adresu a doménu - všechny se routují do inbox@mailrider.local
cd scripts/test-emails
./send-isdoc-email.sh workspace123@faktron.cz
./send-isdoc-email.sh user@example.com
./send-isdoc-email.sh admin@localhost

# Email na bankovní účet
./send-bank-payment.sh fio 5000 2024999 bank.account1@faktron.cz

# Email s obrázkem
./send-image-email.sh ~/Downloads/receipt.png test@mydomain.com
```

### Kontrola příchozích emailů

```bash
# Zobrazí všechny emaily v IMAP INBOX
cd scripts/test-emails
./check-imap-inbox.sh inbox@mailrider.local localhost 1143
```

## Univerzální MailRider Routing

Všechny emaily odeslané na **jakoukoliv** adresu a doménu se uloží do jednoho účtu:

```
workspace123@faktron.cz       → inbox@mailrider.local
user@example.com              → inbox@mailrider.local
admin@localhost               → inbox@mailrider.local
anything@whatever.net         → inbox@mailrider.local
```

Toto umožňuje testovat multi-workspace routing jako v produkci, kde jeden IMAP účet přijímá emaily pro mnoho příjemců a domén.

## Jak to funguje

1. **SMTP příjem**:
   - Node.js `smtp-server` naslouchá na portu 2587
   - Přijme email s `RCPT TO: user@example.com` (nebo jakoukoliv jinou adresu)
   - **NEPROVÁDÍ žádnou kontrolu domény** - přijímá vše
   - Uloží email do Maildir: `/var/mail/faktron.local/inbox/Maildir/new/`

2. **IMAP čtení**:
   - Dovecot čte z Maildir: `/var/mail/faktron.local/inbox/Maildir/`
   - Aplikace se připojí přes IMAP: `inbox@mailrider.local` / `test`
   - Aplikace čte všechny emaily z `INBOX`
   - Každý email má původní `To:` header → aplikace ví, na kterou adresu byl odeslán
   - Aplikace matchuje `To:` s `Workspace.inboxEmail` nebo `CashRegister.bankEmail`

## Výhody oproti GreenMail

- **MailRider routing**: Testování různých příjemců bez nutnosti registrovat každý účet
- **Produkční podobnost**: Stejné chování jako produkční mail server
- **Standard Maildir**: Kompatibilní s jakýmkoliv mail clientem
- **Persistence**: Data přežijí restart kontejneru (volume)
- **Debugging**: Možnost inspekce raw emailů v Maildir

## Technické detaily

### Maildir formát

```
/var/mail/faktron.local/inbox/Maildir/
├── new/          # Nové, nepřečtené emaily
├── cur/          # Aktuální, přečtené emaily
└── tmp/          # Dočasné soubory při zápisu
```

Soubory mají formát: `{timestamp}.{unique}.{hostname}`

### Dovecot autentizace

Použit `passwd-file` driver s formátem:
```
inbox@mailrider.local:{PLAIN}test:5000:5000::/var/mail/faktron.local/inbox:/bin/false
```

### Logy

Obě služby logují do stdout:
```bash
docker logs mailrider -f
```

## Testování aplikace

1. **Spustit mail server**:
   ```bash
   cd docker/dev
   docker-compose up mailrider
   ```

2. **Odeslat testovací emaily**:
   ```bash
   # Email na jakoukoliv adresu - server přijme vše
   ./send-isdoc-email.sh workspace123@faktron.cz
   ./send-isdoc-email.sh test@example.com
   ./send-bank-payment.sh fio 8500 2024999 bank.account1@mycompany.com
   ```

3. **Spustit aplikaci** (v jiném terminálu):
   ```bash
   npm run dev
   ```

4. **Zkontrolovat zpracování**:
   - Aplikace automaticky zjistí nové emaily z IMAP
   - V logu uvidíte: `Email processing started`, `Email saved to EmailMessage`
   - V DB: `EmailProcessingLog` a `EmailMessage` záznamy
   - UI: Nové emaily v Inbox (podle workspace)

## Troubleshooting

### Port už je používán

```bash
# Zjisti, co běží na portu 1143 nebo 2587
lsof -i :1143
lsof -i :2587

# Vypni konfliktní službu (např. starý GreenMail/Stalwart)
docker-compose stop greenmail stalwart
```

### Email se neuloží do Maildir

```bash
# Zkontroluj logy SMTP serveru
docker logs mailrider | grep "SMTP"

# Zkontroluj Maildir permissions
docker exec mailrider ls -la /var/mail/faktron.local/inbox/Maildir/new/
```

### Dovecot nevidí emaily

```bash
# Test IMAP připojení
{ sleep 0.5; echo "a1 LOGIN inbox@mailrider.local test"; sleep 0.5; echo "a2 SELECT INBOX"; sleep 0.5; echo "a3 LOGOUT"; } | nc localhost 1143

# Zkontroluj Dovecot logy
docker logs mailrider | grep "dovecot"
```

### Aplikace nevidí emaily

- Zkontroluj `.env`: `IMAP_PRIMARY_USER=inbox@mailrider.local`, `IMAP_PRIMARY_PORT=1143`
- Zkontroluj `Workspace.inboxEmail` v DB - musí být nastaveno na jakoukoli adresu (např. `workspace123@faktron.cz`)
- Zkontroluj logy aplikace: `EmailDiscoveryService` by měl reportovat nové emaily

## Struktura souborů

```
mailrider/
├── Dockerfile              # Node.js 20 Alpine + Dovecot
├── package.json            # SMTP dependencies
├── smtp-server.js          # SMTP server s MailRider logikou a HTTP API
├── dovecot.conf            # Dovecot IMAP konfigurace
├── start.sh                # Startup orchestrace obou služeb
├── web-ui.html             # Web UI s dark mode a přečteno/nepřečteno
├── README.md               # Kompletní dokumentace
├── QUICKSTART.md           # Rychlý start v 3 krocích
└── API.md                  # HTTP/SMTP/IMAP API dokumentace
```
