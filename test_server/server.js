require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const CONFIG = {
  PORT: process.env.PORT || 3001,
  CHROME_PATH: process.env.CHROME_PATH ? process.env.CHROME_PATH.trim() : '',
  USER_DATA_DIR: './gemini_session_test',
  HEADLESS: process.env.HEADLESS === 'true' ? 'new' : false,
  RESPONSE_TIMEOUT: parseInt(process.env.RESPONSE_TIMEOUT) || 90000
};

let browser = null;
let page = null;
let isProcessing = false;
let responseCounter = 0;
const requestQueue = [];

async function setupBrowser() {
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
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--window-size=1280,800'
    ]
  };

  if (CONFIG.CHROME_PATH) {
    launchOptions.executablePath = CONFIG.CHROME_PATH;
  }

  browser = await puppeteer.launch(launchOptions);
  page = await browser.newPage();
  
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(CONFIG.RESPONSE_TIMEOUT);

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    if (['image', 'font', 'media'].includes(resourceType)) {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  browser.on('disconnected', () => {
    browser = null;
    page = null;
  });

  await page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle2' });

  const isLoggedIn = await page.evaluate(() => {
    return document.querySelector('div[contenteditable="true"]') !== null || 
           document.querySelector('rich-textarea') !== null;
  });

  if (!isLoggedIn && !CONFIG.HEADLESS) {
    console.log('??  BELUM LOGIN. Login manual dulu di jendela browser!');
    try {
      await page.waitForSelector('div[contenteditable="true"]', { timeout: 600000 });
      console.log('? Sesi login terdeteksi!');
    } catch (e) {
      console.error('? Timeout login.');
    }
  }
}

async function ensureBrowser() {
  if (!browser || !page || !browser.isConnected()) {
    if (browser) await browser.close().catch(() => {});
    await setupBrowser();
  }
}

function generateId() {
  return chatcmpl-;
}

async function waitForGenerationComplete(timeout = CONFIG.RESPONSE_TIMEOUT) {
  try {
    await page.waitForFunction(
      () => document.querySelector('model-response, .model-response-text, [data-response-index]') !== null,
      { timeout: 20000 }
    );
  } catch (e) {
    return 'Timeout: respons tidak muncul.';
  }

  try {
    await page.waitForFunction(
      () => {
        const stopBtn = document.querySelector(
          'button[aria-label*="Stop"], button[aria-label*="stop"], ' +
          'button[aria-label*="Cancel"], .stop-button, ' +
          'button.send-button[disabled], mat-icon[fonticon="stop_circle"]'
        );
        window.scrollTo(0, document.body.scrollHeight);
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
      let lang = 'tool';
      const langEl = wrapper.querySelector('.language, .language-name, [class*="language"]');
      if (langEl && langEl.innerText) lang = langEl.innerText.trim();
      const textNode = document.createTextNode("\n\\\" + lang + "\n" + codeText + "\n\\\\n");
      wrapper.parentNode.replaceChild(textNode, wrapper);
    });

    return clone.innerText.trim();
  });

  return reply || 'Gagal narik teks.';
}

async function askGemini(prompt) {
  await ensureBrowser();

  responseCounter++;
  if (responseCounter > 5) {
    console.log('Resetting session to keep it light...');
    await page.goto('https://gemini.google.com/app', { waitUntil: 'networkidle2' });
    responseCounter = 0;
  }

  const prevCount = await page.evaluate(() => {
    return document.querySelectorAll('model-response, .model-response-text').length;
  });

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

  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.press('Enter');

  try {
    await page.waitForFunction(
      (c) => document.querySelectorAll('model-response, .model-response-text').length > c,
      { timeout: 20000 },
      prevCount
    );
  } catch(e) {}

  return await waitForGenerationComplete();
}

function enqueueRequest(handler) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ handler, resolve, reject });
    if (!isProcessing) processQueue();
  });
}

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) {
    isProcessing = false;
    return;
  }
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', browserReady: !!(browser && page), queue: requestQueue.length });
});

app.post('/v1/chat/completions', async (req, res) => {
  const isStream = req.body.stream === true;
  try {
    const messages = req.body.messages || [];
    const finalPrompt = messages.map(m => "[" + m.role.toUpperCase() + "]: " + m.content).join('\n\n');

    const reply = await enqueueRequest(() => askGemini(finalPrompt));

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const id = generateId();
      const words = reply.match(/(\s+|\S+)/g) || [];
      for (const word of words) {
        res.write("data: " + JSON.stringify({ id, choices: [{ delta: { content: word } }] }) + "\n\n");
        await new Promise(r => setTimeout(r, 5));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({ id: generateId(), choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

app.listen(CONFIG.PORT, async () => {
  console.log("Test server active on port " + CONFIG.PORT);
  await setupBrowser().catch(e => console.error('Launch error:', e.message));
});
