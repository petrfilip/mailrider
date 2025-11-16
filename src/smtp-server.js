#!/usr/bin/env node

/**
 * Catch-all SMTP Server pro lokální vývoj
 *
 * Účel:
 * - Přijímá SMTP emaily na JAKOUKOLIV adresu a doménu (universální catch-all)
 * - Všechny emaily ukládá do Maildir formátu do jednoho účtu
 * - Dovecot IMAP server pak čte z tohoto Maildir
 *
 * Běží jako součást Docker kontejneru spolu s Dovecotem.
 */

const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const express = require('express');
const sharp = require('sharp');
const multer = require('multer');

// Logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  },
});

// Konfigurace
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '2587', 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || '8082', 10);
const MAILDIR_BASE = process.env.MAILDIR_BASE || '/var/mail/faktron.local';
const MAILRIDER_USER = process.env.MAILRIDER_USER || 'inbox';
const MAILRIDER_DOMAIN = process.env.MAILRIDER_DOMAIN || 'mailrider.local';
const MAILRIDER_EMAIL = `${MAILRIDER_USER}@${MAILRIDER_DOMAIN}`;

// Info: MAILRIDER_DOMAIN je jen pro zobrazení, server přijímá VŠECHNY domény

// Maildir struktura pro MailRider účet
const MAILDIR_PATH = path.join(MAILDIR_BASE, MAILRIDER_USER, 'Maildir');
const MAILDIR_NEW = path.join(MAILDIR_PATH, 'new');
const MAILDIR_CUR = path.join(MAILDIR_PATH, 'cur');
const MAILDIR_TMP = path.join(MAILDIR_PATH, 'tmp');

// Metadata soubor pro přečtené/nepřečtené emaily
const METADATA_FILE = path.join(MAILDIR_BASE, MAILRIDER_USER, '.read-status.json');

/**
 * Validates filename to prevent path traversal attacks
 * @param {string} filename - The filename to validate
 * @throws {Error} If filename is invalid
 */
function validateFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid filename: empty or not a string');
  }

  // Check for path traversal attempts
  if (filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename: contains path separators');
  }

  if (filename.includes('..')) {
    throw new Error('Invalid filename: contains parent directory reference');
  }

  // Check for null bytes
  if (filename.includes('\0')) {
    throw new Error('Invalid filename: contains null byte');
  }

  // Check for common malicious patterns
  if (/^\./.test(filename)) {
    throw new Error('Invalid filename: starts with dot');
  }

  return filename;
}

/**
 * Metadata management pro read status
 */
let readStatusCache = null;

// Simple mutex implementation to prevent race conditions
let readStatusLock = Promise.resolve();

/**
 * Acquire lock for read status operations
 * @returns {Promise<Function>} Release function
 */
function acquireReadStatusLock() {
  let release;
  const promise = new Promise(resolve => {
    release = resolve;
  });

  const currentLock = readStatusLock;
  readStatusLock = readStatusLock.then(() => promise);

  return currentLock.then(() => release);
}

async function loadReadStatus() {
  const release = await acquireReadStatusLock();
  try {
    const content = await fs.readFile(METADATA_FILE, 'utf-8');
    readStatusCache = JSON.parse(content);
  } catch (error) {
    // File doesn't exist yet or is corrupted
    readStatusCache = {};
  } finally {
    release();
  }
  return readStatusCache;
}

async function saveReadStatus() {
  const release = await acquireReadStatusLock();
  try {
    await fs.writeFile(METADATA_FILE, JSON.stringify(readStatusCache, null, 2));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to save read status');
  } finally {
    release();
  }
}

async function markAsRead(filename) {
  if (!readStatusCache) await loadReadStatus();
  readStatusCache[filename] = true;
  await saveReadStatus();
}

async function markAsUnread(filename) {
  if (!readStatusCache) await loadReadStatus();
  delete readStatusCache[filename];
  await saveReadStatus();
}

function isRead(filename) {
  return readStatusCache && readStatusCache[filename] === true;
}

/**
 * Vytvoří Maildir strukturu, pokud neexistuje
 */
async function ensureMaildirStructure() {
  try {
    await fs.mkdir(MAILDIR_NEW, { recursive: true });
    await fs.mkdir(MAILDIR_CUR, { recursive: true });
    await fs.mkdir(MAILDIR_TMP, { recursive: true });

    // Načti read status
    await loadReadStatus();

    logger.info({
      maildirPath: MAILDIR_PATH,
      mailriderEmail: MAILRIDER_EMAIL
    }, 'Maildir structure initialized');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to create Maildir structure');
    throw error;
  }
}

/**
 * Uloží email do Maildir formátu
 *
 * Maildir naming convention:
 * {timestamp}.{unique}.{hostname}
 *
 * @param {Buffer} emailBuffer - Raw email content
 */
async function saveToMaildir(emailBuffer) {
  const timestamp = Math.floor(Date.now() / 1000);
  const unique = crypto.randomBytes(8).toString('hex');
  const hostname = 'mailrider';

  const filename = `${timestamp}.${unique}.${hostname}`;
  const tmpPath = path.join(MAILDIR_TMP, filename);
  const newPath = path.join(MAILDIR_NEW, filename);

  try {
    // Nejprve zapsat do tmp (atomicita)
    await fs.writeFile(tmpPath, emailBuffer);

    // Nastav správné ownership (vmail:vmail = 5000:5000) a permissions
    await fs.chown(tmpPath, 5000, 5000);
    await fs.chmod(tmpPath, 0o600);

    // Pak přesunout do new (Dovecot ho přesune do cur když se přečte)
    await fs.rename(tmpPath, newPath);

    logger.info({
      filename,
      size: emailBuffer.length,
      destination: MAILRIDER_EMAIL
    }, 'Email saved to Maildir');

    return newPath;
  } catch (error) {
    logger.error({
      error: error.message,
      filename
    }, 'Failed to save email to Maildir');

    // Cleanup tmp file if exists
    try {
      await fs.unlink(tmpPath);
    } catch {}

    throw error;
  }
}

/**
 * Format email address for display (removes quotes from name)
 * @param {Object} addressObj - Parsed address object from mailparser
 * @returns {string} Formatted email address
 */
function formatEmailAddress(addressObj) {
  if (!addressObj) return 'Unknown';

  // addressObj.value is an array of address objects
  if (addressObj.value && addressObj.value.length > 0) {
    const addresses = addressObj.value.map(addr => {
      const name = addr.name || '';
      const address = addr.address || '';

      if (name && address) {
        // Remove quotes from name if present
        const cleanName = name.replace(/^["']|["']$/g, '');
        return `${cleanName} <${address}>`;
      }
      return address || 'Unknown';
    });
    return addresses.join(', ');
  }

  // Fallback to text property (remove quotes if present)
  const text = addressObj.text || 'Unknown';
  return text.replace(/"([^"]+)"/g, '$1');
}

/**
 * Parse a zobraz metadata emailu (pro logging)
 */
async function parseEmailMetadata(emailBuffer) {
  try {
    const parsed = await simpleParser(emailBuffer);
    return {
      messageId: parsed.messageId,
      from: formatEmailAddress(parsed.from),
      to: formatEmailAddress(parsed.to),
      subject: parsed.subject,
      date: parsed.date,
    };
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to parse email metadata');
    return null;
  }
}

/**
 * Web UI & API Server
 */
const app = express();

// Multer configuration for EML file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    // Accept only .eml files or message/rfc822 content type
    if (file.originalname.endsWith('.eml') || file.mimetype === 'message/rfc822') {
      cb(null, true);
    } else {
      cb(new Error('Only .eml files are allowed'));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024, // Max 50MB per file
  },
});

// Serve static HTML
app.get('/', async (req, res) => {
  try {
    const html = await fs.readFile(path.join(__dirname, 'web-ui.html'), 'utf-8');
    res.type('html').send(html);
  } catch (error) {
    res.status(500).send('Error loading UI');
  }
});

/**
 * Najde všechny IMAP složky v Maildir
 * @returns {Promise<Array<{name: string, path: string}>>} Seznam složek
 */
async function findMaildirFolders() {
  const folders = [];

  // INBOX (hlavní složka)
  folders.push({ name: 'INBOX', path: MAILDIR_PATH });

  try {
    // Najdi všechny podsložky začínající tečkou (Maildir konvence pro IMAP složky)
    const entries = await fs.readdir(MAILDIR_PATH, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('.')) {
        // Odstraň tečku ze začátku pro zobrazení
        const folderName = entry.name.substring(1);
        const folderPath = path.join(MAILDIR_PATH, entry.name);
        folders.push({ name: folderName, path: folderPath });
      }
    }
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to scan for IMAP folders');
  }

  return folders;
}

/**
 * Přečte emaily z jedné Maildir složky (new + cur)
 * @param {string} folderName - Název složky pro zobrazení
 * @param {string} folderPath - Cesta k Maildir složce
 * @returns {Promise<Array>} Seznam emailů
 */
async function readEmailsFromFolder(folderName, folderPath) {
  const emails = [];

  // Čti z obou podsložek (new = nepřečtené, cur = přečtené)
  const subfolders = ['new', 'cur'];

  for (const subfolder of subfolders) {
    const subfolderPath = path.join(folderPath, subfolder);

    try {
      const files = await fs.readdir(subfolderPath);

      for (const file of files) {
        // Přeskoč speciální soubory (Dovecot metadata)
        if (file.startsWith('dovecot-')) continue;

        const filePath = path.join(subfolderPath, file);

        try {
          const stats = await fs.stat(filePath);
          const content = await fs.readFile(filePath);
          const parsed = await simpleParser(content);

          emails.push({
            filename: file,
            folder: folderName,
            subfolder: subfolder, // 'new' nebo 'cur'
            timestamp: parseInt(file.split('.')[0]) || 0,
            size: stats.size,
            from: formatEmailAddress(parsed.from),
            to: formatEmailAddress(parsed.to),
            subject: parsed.subject || '(No subject)',
            preview: (parsed.text || '').substring(0, 200),
            attachmentCount: parsed.attachments?.length || 0,
            isRead: isRead(file),
          });
        } catch (parseError) {
          // Skip malformed emails
          logger.warn({ file, error: parseError.message }, 'Failed to parse email for API');
        }
      }
    } catch (error) {
      // Složka neexistuje nebo není přístupná
      if (error.code !== 'ENOENT') {
        logger.warn({ folderName, subfolder, error: error.message }, 'Failed to read subfolder');
      }
    }
  }

  return emails;
}

/**
 * Najde email podle filename ve všech IMAP složkách
 * @param {string} filename - Název souboru emailu
 * @returns {Promise<{path: string, folder: string, subfolder: string}|null>} Cesta k emailu nebo null
 */
async function findEmailByFilename(filename) {
  const folders = await findMaildirFolders();
  const subfolders = ['new', 'cur'];

  for (const folder of folders) {
    for (const subfolder of subfolders) {
      const emailPath = path.join(folder.path, subfolder, filename);

      try {
        await fs.access(emailPath);
        return {
          path: emailPath,
          folder: folder.name,
          subfolder: subfolder,
        };
      } catch {
        // Email není v této složce, zkus další
        
      }
    }
  }

  return null;
}

// API: Get all emails
app.get('/api/emails', async (req, res) => {
  try {
    const folders = await findMaildirFolders();
    const allEmails = [];
    let totalSize = 0;

    // Přečti emaily ze všech složek
    for (const folder of folders) {
      const folderEmails = await readEmailsFromFolder(folder.name, folder.path);
      allEmails.push(...folderEmails);
    }

    // Vypočítej celkovou velikost
    totalSize = allEmails.reduce((sum, email) => sum + email.size, 0);

    // Seřaď podle timestampu (nejnovější první)
    allEmails.sort((a, b) => b.timestamp - a.timestamp);

    res.json({
      total: allEmails.length,
      totalSize,
      emails: allEmails,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'API error: list emails');
    res.status(500).json({ error: error.message });
  }
});

// API: Bulk delete all emails (must be before /:filename route)
app.delete('/api/emails/all', async (req, res) => {
  try {
    const folders = await findMaildirFolders();
    const subfolders = ['new', 'cur'];
    let deletedCount = 0;

    // Projdi všechny složky a podsložky
    for (const folder of folders) {
      for (const subfolder of subfolders) {
        const subfolderPath = path.join(folder.path, subfolder);

        try {
          const files = await fs.readdir(subfolderPath);

          for (const file of files) {
            // Přeskoč speciální soubory (Dovecot metadata)
            if (file.startsWith('dovecot-')) continue;

            try {
              await fs.unlink(path.join(subfolderPath, file));
              deletedCount++;
            } catch (err) {
              logger.warn({ file, folder: folder.name, error: err.message }, 'Failed to delete email');
            }
          }
        } catch (err) {
          // Složka neexistuje nebo není přístupná
          if (err.code !== 'ENOENT') {
            logger.warn({ folder: folder.name, subfolder, error: err.message }, 'Failed to read subfolder for bulk delete');
          }
        }
      }
    }

    // Cleanup entire cache to prevent memory leak
    readStatusCache = {};
    await saveReadStatus();

    logger.info({ deletedCount }, 'Bulk delete completed');
    res.json({ success: true, deletedCount });
  } catch (error) {
    logger.error({ error: error.message }, 'API error: bulk delete');
    res.status(500).json({ error: error.message });
  }
});

// API: Delete email
app.delete('/api/emails/:filename', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const emailLocation = await findEmailByFilename(filename);

    if (!emailLocation) {
      return res.status(404).json({ error: 'Email not found' });
    }

    await fs.unlink(emailLocation.path);

    // Cleanup cache to prevent memory leak
    if (readStatusCache && readStatusCache[filename]) {
      delete readStatusCache[filename];
      await saveReadStatus();
    }

    logger.info({ filename, folder: emailLocation.folder }, 'Email deleted via API');
    res.json({ success: true });
  } catch (error) {
    logger.error({ error: error.message }, 'API error: delete email');
    res.status(500).json({ error: error.message });
  }
});

// API: Get full email detail with all parts
app.get('/api/emails/:filename/full', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const emailLocation = await findEmailByFilename(filename);

    if (!emailLocation) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const content = await fs.readFile(emailLocation.path);
    const parsed = await simpleParser(content);

    // Extract headers
    const headers = {};
    const emailHeaderKeys = [
      'from', 'to', 'cc', 'bcc', 'reply-to', 'sender',
      'delivered-to', 'return-path',
      'resent-from', 'resent-to', 'resent-cc', 'resent-bcc', 'resent-sender'
    ];

    if (parsed.headers) {
      for (const [key, value] of parsed.headers) {
        // Special handling for email address headers
        if (emailHeaderKeys.includes(key.toLowerCase())) {
          headers[key] = formatEmailAddress(value);
        } else if (Array.isArray(value)) {
          // If it's an array, convert each element to string
          headers[key] = value.map(v => {
            if (typeof v === 'object' && v !== null) {
              // For objects, try to get a meaningful string representation
              return v.value || v.text || JSON.stringify(v);
            }
            return String(v);
          }).join(', ');
        } else if (typeof value === 'object' && value !== null) {
          // For objects, try to get a meaningful string representation
          headers[key] = value.value || value.text || JSON.stringify(value);
        } else {
          headers[key] = value;
        }
      }
    }

    // Process attachments
    const attachments = (parsed.attachments || []).map((att, index) => ({
      index,
      filename: att.filename || `attachment-${index}`,
      contentType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
      contentId: att.contentId,
      isImage: (att.contentType || '').startsWith('image/'),
    }));

    res.json({
      filename,
      folder: emailLocation.folder,
      messageId: parsed.messageId,
      from: formatEmailAddress(parsed.from),
      to: formatEmailAddress(parsed.to),
      cc: parsed.cc ? formatEmailAddress(parsed.cc) : undefined,
      subject: parsed.subject || '(No subject)',
      date: parsed.date,
      headers,
      textBody: parsed.text || '',
      htmlBody: parsed.html || '',
      rawContent: content.toString(),
      attachments,
      isRead: isRead(filename),
    });
  } catch (error) {
    logger.error({ error: error.message }, 'API error: get full email');
    res.status(500).json({ error: error.message });
  }
});

// API: Download attachment
app.get('/api/emails/:filename/attachments/:index', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const attachmentIndex = parseInt(req.params.index);
    const emailLocation = await findEmailByFilename(filename);

    if (!emailLocation) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const content = await fs.readFile(emailLocation.path);
    const parsed = await simpleParser(content);

    if (!parsed.attachments || attachmentIndex >= parsed.attachments.length) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachment = parsed.attachments[attachmentIndex];

    res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename || 'attachment'}"`);
    res.send(attachment.content);
  } catch (error) {
    logger.error({ error: error.message }, 'API error: download attachment');
    res.status(500).json({ error: error.message });
  }
});

// API: Get attachment thumbnail (for images)
app.get('/api/emails/:filename/attachments/:index/thumb', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const attachmentIndex = parseInt(req.params.index);
    const emailLocation = await findEmailByFilename(filename);

    if (!emailLocation) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const content = await fs.readFile(emailLocation.path);
    const parsed = await simpleParser(content);

    if (!parsed.attachments || attachmentIndex >= parsed.attachments.length) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const attachment = parsed.attachments[attachmentIndex];

    // Check if it's an image
    if (!(attachment.contentType || '').startsWith('image/')) {
      return res.status(400).json({ error: 'Not an image attachment' });
    }

    // Generate thumbnail using sharp
    const thumbnail = await sharp(attachment.content)
      .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.send(thumbnail);
  } catch (error) {
    logger.error({ error: error.message }, 'API error: generate thumbnail');
    res.status(500).json({ error: error.message });
  }
});

// API: Export email as .eml
app.get('/api/emails/:filename.eml', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    const emailLocation = await findEmailByFilename(filename);

    if (!emailLocation) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const content = await fs.readFile(emailLocation.path);

    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.eml"`);
    res.send(content);
  } catch (error) {
    logger.error({ error: error.message }, 'API error: export eml');
    res.status(500).json({ error: error.message });
  }
});

// API: Mark email as read
app.post('/api/emails/:filename/read', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    await markAsRead(filename);
    logger.debug({ filename }, 'Email marked as read');
    res.json({ success: true, isRead: true });
  } catch (error) {
    logger.error({ error: error.message }, 'API error: mark as read');
    res.status(500).json({ error: error.message });
  }
});

// API: Mark email as unread
app.post('/api/emails/:filename/unread', async (req, res) => {
  try {
    const filename = validateFilename(req.params.filename);
    await markAsUnread(filename);
    logger.debug({ filename }, 'Email marked as unread');
    res.json({ success: true, isRead: false });
  } catch (error) {
    logger.error({ error: error.message }, 'API error: mark as unread');
    res.status(500).json({ error: error.message });
  }
});

// API: Import EML files
app.post('/api/emails/import', upload.array('emlFiles', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const results = {
      total: req.files.length,
      imported: 0,
      failed: 0,
      errors: [],
    };

    for (const file of req.files) {
      try {
        // Save the EML file content to Maildir
        await saveToMaildir(file.buffer);
        results.imported++;

        logger.info({
          filename: file.originalname,
          size: file.size,
        }, 'EML file imported successfully');
      } catch (error) {
        results.failed++;
        results.errors.push({
          filename: file.originalname,
          error: error.message,
        });

        logger.error({
          filename: file.originalname,
          error: error.message,
        }, 'Failed to import EML file');
      }
    }

    res.json(results);
  } catch (error) {
    logger.error({ error: error.message }, 'API error: import EML');
    res.status(500).json({ error: error.message });
  }
});

/**
 * SMTP Server setup
 */
const server = new SMTPServer({
  // Povolit přihlášení bez TLS (lokální dev)
  secure: false,
  authOptional: true,

  // Žádná autentizace potřeba (lokální dev)
  disabledCommands: ['AUTH'],

  // Banner
  banner: 'Faktron Catch-all SMTP Server',

  // Log úroveň
  logger: process.env.SMTP_DEBUG === 'true',

  // Handler pro RCPT TO (příjemce)
  onRcptTo(address, session, callback) {
    const email = address.address.toLowerCase();

    // Přijmout všechny domény (MailRider routing pro celý server)
    logger.debug({
      originalRecipient: email,
      routedTo: MAILRIDER_EMAIL
    }, 'MailRider routing');

    callback();
  },

  // Handler pro příjem emailu
  onData(stream, session, callback) {
    const chunks = [];

    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    stream.on('end', async () => {
      const emailBuffer = Buffer.concat(chunks);

      try {
        // Parse metadata pro logging
        const metadata = await parseEmailMetadata(emailBuffer);

        logger.info({
          from: session.envelope.mailFrom?.address,
          to: session.envelope.rcptTo.map(r => r.address),
          subject: metadata?.subject,
          size: emailBuffer.length
        }, 'Receiving email');

        // Ulož do Maildir
        await saveToMaildir(emailBuffer);

        callback();
      } catch (error) {
        logger.error({
          error: error.message,
          from: session.envelope.mailFrom?.address
        }, 'Failed to process email');

        callback(new Error('Failed to save email'));
      }
    });

    stream.on('error', (error) => {
      logger.error({ error: error.message }, 'Stream error');
      callback(error);
    });
  },
});

/**
 * Start servers
 */
async function start() {
  try {
    // Vytvoř Maildir strukturu
    await ensureMaildirStructure();

    // Start Web UI server
    const webServer = app.listen(WEB_PORT, '0.0.0.0', () => {
      logger.info({
        port: WEB_PORT,
        url: `http://localhost:${WEB_PORT}`
      }, 'Web UI started');
    });

    // Start SMTP server
    server.listen(SMTP_PORT, '0.0.0.0', () => {
      logger.info({
        port: SMTP_PORT,
        mailriderEmail: MAILRIDER_EMAIL,
        maildirPath: MAILDIR_PATH
      }, 'SMTP server started');
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutting down servers');

      // Close web server
      webServer.close(() => {
        logger.info('Web server closed');
      });

      // Close SMTP server
      server.close(() => {
        logger.info('SMTP server closed');
        process.exit(0);
      });

      // Force exit after 5 seconds
      setTimeout(() => {
        logger.warn('Forcing exit after timeout');
        process.exit(1);
      }, 5000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start servers');
    process.exit(1);
  }
}

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

// Start the server
start();
