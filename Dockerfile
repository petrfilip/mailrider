FROM node:20-alpine

# Metadata
LABEL maintainer="Petr Filip"
LABEL org.opencontainers.image.title="MailRider"
LABEL org.opencontainers.image.description="Universal SMTP + IMAP mail server for local development"
LABEL org.opencontainers.image.url="https://github.com/petrfilip/mailrider"
LABEL org.opencontainers.image.source="https://github.com/petrfilip/mailrider"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.licenses="MIT"

# Install system dependencies
RUN apk add --no-cache \
    dovecot \
    dovecot-lmtpd \
    bash \
    netcat-openbsd \
    && rm -rf /var/cache/apk/*

# Create vmail user for Dovecot
RUN addgroup -g 5000 vmail \
    && adduser -D -u 5000 -G vmail -h /var/mail -s /bin/false vmail

# Create mail directories
RUN mkdir -p /var/mail/faktron.local/inbox/Maildir/{new,cur,tmp} \
    && chown -R vmail:vmail /var/mail/faktron.local

# Set working directory
WORKDIR /app

# Copy package files for dependency installation (layer caching)
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production --no-audit --no-fund

# Copy application source files
COPY src/ ./src/

# Copy configuration files
COPY config/dovecot.conf /etc/dovecot/dovecot.conf
COPY config/start.sh /start.sh
RUN chmod +x /start.sh

# Create Dovecot users file
# Format: username:password:uid:gid::home:shell
ARG MAILRIDER_USER=inbox
ARG MAILRIDER_DOMAIN=mailrider.local
RUN echo "${MAILRIDER_USER}@${MAILRIDER_DOMAIN}:{PLAIN}test:5000:5000::/var/mail/faktron.local/inbox:/bin/false" > /etc/dovecot/users \
    && chmod 644 /etc/dovecot/users

# Expose ports
EXPOSE 2587 143 8082

# Environment variables with defaults
ENV SMTP_PORT=2587 \
    WEB_PORT=8082 \
    MAILDIR_BASE=/var/mail/faktron.local \
    MAILRIDER_USER=${MAILRIDER_USER} \
    MAILRIDER_DOMAIN=${MAILRIDER_DOMAIN} \
    LOG_LEVEL=info \
    NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD nc -z localhost 143 && nc -z localhost 2587 || exit 1

# Start both services
CMD ["/start.sh"]
