require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

const CONFIG = {
  PORT: process.env.PORT || 3000,
  CHROME_PATH: process.env.CHROME_PATH ? process.env.CHROME_PATH.trim() : '',
  USER_DATA_DIR: process.env.USER_DATA_DIR ? process.env.USER_DATA_DIR.trim() : './gemini_session',
  HEADLESS: process.env.HEADLESS === 'true' ? 'new' : false,
  RESPONSE_TIMEOUT: parseInt(process.env.RESPONSE_TIMEOUT) || 90000
};

let browser = null;
let page = null;
let isProcessing = false;
let isInitializing = false;
const requestQueue = [];

async function setupBrowser() {
  isInitializing = true;
  const launchOptions = {
    headless: CONFIG.HEADLESS,
    userDataDir: CONFIG.USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--hide-crash-restore-bubble',
      '--disable-dev-shm-usage',
      '--window-size=1280,800',
      '--disable-gpu'
    ]
  };

  if (CONFIG.CHROME_PATH) {
    launchOptions.executablePath = CONFIG.CHROME_PATH;
  }

  try {
    browser = await puppeteer.launch(launchOptions);
    page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    browser.on('disconnected', () => {
      browser = null;
      page = null;
    });

    await page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle2', timeout: 60000 });
  } finally {
    isInitializing = false;
  }
}

async function ensureBrowser() {
  if (!browser || !page || browser.isConnected() === false) {
    if (isInitializing) {
      while (isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return;
    }
    if (browser) await browser.close().catch(() => {});
    await setupBrowser();
  }
}

function generateId() {
  return `chatcmpl-${crypto.randomBytes(16).toString('hex')}`;
}

async function waitForGenerationComplete(timeout = CONFIG.RESPONSE_TIMEOUT) {
  try {
    await page.waitForFunction(
      () => document.querySelector('model-response, .model-response-text, [data-response-index]') !== null,
      { timeout: 15000 }
    );
  } catch (e) {
    return 'Timeout: elemen response tidak ditemukan.';
  }

  try {
    await page.waitForFunction(
      () => {
        const stopBtn = document.querySelector(
          'button[aria-label*="Stop"], button[aria-label*="stop"], ' +
          'button[aria-label*="Cancel"], .stop-button, ' +
          'button.send-button[disabled], mat-icon[fonticon="stop_circle"]'
        );
        return stopBtn === null;
      },
      { timeout, polling: 500 }
    );
  } catch (e) {}

  const reply = await page.evaluate(() => {
    const selectors = [
      'message-content model-response',
      '.markdown.markdown-main-panel',
      '.model-response-text',
      'model-response',
      '[data-response-index]'
    ];
    
    let targetNode = null;
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) {
        targetNode = nodes[nodes.length - 1];
        break;
      }
    }
    
    if (!targetNode) return '';

    const clone = targetNode.cloneNode(true);
    clone.querySelectorAll('code-block, .code-block, pre').forEach(wrapper => {
      const pre = wrapper.tagName === 'PRE' ? wrapper : (wrapper.querySelector('pre') || wrapper);
      const codeText = pre.innerText;
      let lang = 'text';
      const langEl = wrapper.querySelector('.language, .language-name, [class*="language"]');
      if (langEl) lang = langEl.innerText.trim();
      const textNode = document.createTextNode(`\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`);
      wrapper.parentNode.replaceChild(textNode, wrapper);
    });

    return clone.innerText.trim();
  });

  return reply || 'Tidak dapat membaca balasan.';
}

async function askGemini(prompt) {
  await ensureBrowser();

  const responseCount = await page.evaluate(() => document.querySelectorAll('.model-response-text').length);
  if (responseCount > 10) {
    await page.reload({ waitUntil: 'networkidle2' });
  }

  const prevCount = await page.evaluate(() => document.querySelectorAll('model-response, .model-response-text').length);

  const inputEl = await page.waitForSelector('div[contenteditable="true"]', { timeout: 15000 });
  await inputEl.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');

  await page.evaluate((text) => {
    const el = document.querySelector('div[contenteditable="true"]');
    document.execCommand('insertText', false, text);
  }, prompt);

  await new Promise(r => setTimeout(r, 500));
  await page.keyboard.press('Enter');

  try {
    await page.waitForFunction(
      (c) => document.querySelectorAll('model-response, .model-response-text').length > c,
      { timeout: 15000 },
      prevCount
    );
  } catch(e) {}

  return await waitForGenerationComplete();
}

app.post('/v1/chat/completions', async (req, res) => {
  const isStream = req.body.stream === true;
  const requestId = generateId();

  try {
    const messages = req.body.messages || [];
    const finalPrompt = messages.map(m => {
        let content = typeof m.content === 'string' ? m.content : 'File data';
        return `[${m.role.toUpperCase()}]: ${content}`;
    }).join('\n\n') + '\n\nPENTING: Jawab instruksi terakhir. Jika memakai tool, gunakan format markdown ```tool ... ```';

    if (!finalPrompt.trim()) {
      return res.status(400).json({ error: { message: 'Prompt kosong' } });
    }

    const reply = await new Promise((resolve, reject) => {
      requestQueue.push({ handler: () => askGemini(finalPrompt), resolve, reject });
      if (!isProcessing) processQueue();
    });

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const words = reply.match(/(\s+|\S+)/g) || [];
      for (const word of words) {
        if (res.writableEnded) break;
        const chunk = { 
          id: requestId, 
          object: 'chat.completion.chunk', 
          created: Math.floor(Date.now()/1000), 
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }] 
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (word.length > 10) await new Promise(r => setTimeout(r, 5));
      }
      res.write(`data: ${JSON.stringify({ id: requestId, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({ 
        id: requestId, 
        object: 'chat.completion', 
        created: Math.floor(Date.now()/1000), 
        choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] 
      });
    }

  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

async function processQueue() {
  if (requestQueue.length === 0) { isProcessing = false; return; }
  isProcessing = true;
  const { handler, resolve, reject } = requestQueue.shift();
  try {
    const result = await handler();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    processQueue();
  }
}

async function gracefulShutdown() {
  if (browser) await browser.close();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

app.listen(CONFIG.PORT, async () => {
  console.log(`Server jalan di port ${CONFIG.PORT}`);
  setupBrowser().catch(console.error);
});