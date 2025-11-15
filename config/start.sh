#!/bin/bash
set -e

echo "========================================"
echo "MailRider Mail Server Starting"
echo "========================================"

# Create Maildir structure if it doesn't exist
mkdir -p /var/mail/faktron.local/inbox/Maildir/{new,cur,tmp}

# Ensure proper permissions
chown -R vmail:vmail /var/mail/faktron.local
# Set 755 for directories and 644 for files so they're readable from host
chmod 755 /var/mail/faktron.local/inbox/Maildir
chmod 755 /var/mail/faktron.local/inbox/Maildir/{new,cur,tmp}
find /var/mail/faktron.local/inbox/Maildir -type f -exec chmod 644 {} \;

# Start Dovecot IMAP server
echo "Starting Dovecot IMAP server..."
dovecot -F &
DOVECOT_PID=$!

# Wait for Dovecot to be ready
sleep 2

# Start Node.js SMTP server
echo "Starting Node.js SMTP server..."
cd /app
node src/smtp-server.js &
SMTP_PID=$!

echo "========================================"
echo "MailRider Mail Server Ready"
echo "  SMTP: localhost:2587"
echo "  IMAP: localhost:143"
echo "  MailRider: *@* (ALL domains) -> inbox@mailrider.local"
echo "  Credentials: inbox@mailrider.local / test"
echo "  Web UI: http://localhost:8082"
echo "========================================"

# Graceful shutdown handler
shutdown() {
    echo ""
    echo "Shutting down services..."

    # Kill SMTP server
    if [ ! -z "$SMTP_PID" ]; then
        kill -TERM $SMTP_PID 2>/dev/null || true
        wait $SMTP_PID 2>/dev/null || true
    fi

    # Kill Dovecot
    if [ ! -z "$DOVECOT_PID" ]; then
        kill -TERM $DOVECOT_PID 2>/dev/null || true
        wait $DOVECOT_PID 2>/dev/null || true
    fi

    echo "Services stopped"
    exit 0
}

trap shutdown SIGTERM SIGINT

# Wait for both processes
wait -n

# If one process exits, shutdown everything
shutdown
