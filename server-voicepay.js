import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import multer from "multer";
import gTTS from 'gtts'; // NEW - for audio
import fs from 'fs'; // NEW - for audio
import path from 'path'; // NEW - for audio

dotenv.config();
const app = express();

app.use(cors({
  origin: ['https://harpstech-ng.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'application/json', limit: '10mb' })); // FIX FOR EMPTY BODY
app.use(express.static('.'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// DEMO MEMORY STORAGE - NO DATABASE NEEDED
global.VOICE_MEMORY = {};
global.TRANSACTION_MEMORY = {};
global.DURESS_MEMORY = {};
global.PIN_MEMORY = {};

async function saveToMemory(collection, docId, data) {
  if (collection === 'users') global.VOICE_MEMORY[docId] = {...global.VOICE_MEMORY[docId],...data };
  else if (collection === 'transactions') global.TRANSACTION_MEMORY[docId] = data;
  else if (collection === 'duress_logs') global.DURESS_MEMORY[docId] = data;
  else if (collection === 'pins') global.PIN_MEMORY[docId] = data;
  return;
}

async function getFromMemory(collection, docId) {
  if (collection === 'users') return global.VOICE_MEMORY[docId] || null;
  if (collection === 'transactions') return global.TRANSACTION_MEMORY[docId] || null;
  if (collection === 'pins') return global.PIN_MEMORY[docId] || null;
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in Groq response");
  return JSON.parse(match[0]);
}

async function chat(prompt) {
  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: "llama-3.1-8b-instant",
    temperature: 0.1,
  });
  return completion.choices[0]?.message?.content || "";
}

app.post("/parse-voice-command", async (req, res) => {
  try {
    const { transcript, userId } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    console.log('[VOICEPAY] User said:', transcript);

    let duress = false;
    if (userId) {
      const userData = await getFromMemory('users', userId);
      const duressPhrase = userData?.duressPhrase || 'transfer urgent money';
      if (transcript.toLowerCase().includes(duressPhrase.toLowerCase())) {
        duress = true;
        console.log('[DURESS] Detected for user:', userId);
      }
    }

    const SYSTEM_PROMPT = `You are VoicePay AI for Nigerian elders. Understand broken English + 5 languages. NEVER say "I don't understand".

LANGUAGE RULES:
1. ENGLISH: "Send five thousand to Seyi" = amount:5000, recipient:Seyi
2. YORUBA: "Fi ẹgbẹrun mewa ranṣẹ si Baba" = Send 10000 to Baba. "Mo fe fi owo ranṣẹ" = I want to send money
3. HAUSA: "Tura dubu biyar zuwa Amina" = Send 5000 to Amina. "Ina son in tura kudi" = I want to send money
4. IGBO: "Ziga puku ego na Chioma" = Send 1000 to Chioma
5. PIDGIN: "Abeg send Seyi 5k make I see" = Send 5000 to Seyi. "Dash Mama 2k" = Send 2000 to Mama
6. Amounts: "five"=5000, "two"=2000, "ten"=10000, "1k"=1000, "2.5k"=2500, "ẹgbẹrun"=1000, "dubu"=1000
7. If amount missing: Ask "How much to NAME, please?"
8. If name missing: Ask "Send ₦AMOUNT to who, please?"
9. ALWAYS use ₦ Naira
10. Be respectful: Use "please" for elders

Return ONLY JSON: {"intent":"transfer|buy_airtime|check_balance|chitchat|unknown","amount":number,"recipient":string,"language_detected":"en|yo|ha|ig|pcm","confidence":0-1,"response":"short respectful reply under 12 words","needs_confirmation":boolean}`;

    const text = await chat(`${SYSTEM_PROMPT}\n\nUser speech: "${transcript}"`);
    console.log('[VOICEPAY] Groq raw:', text);
    let json = extractJSON(text.trim());
    json.duress = duress;

    if (json.intent === "chitchat") {
      json.response = json.response || "Good morning. How can I help?";
      json.needs_confirmation = false;
    } else if (json.intent === "check_balance") {
      json.response = "Tap 'Check Balance' to view";
      json.needs_confirmation = false;
    } else if (json.intent === "transfer") {
      if (!json.amount &&!json.recipient) {
        json.response = "Who do you want to send money to, please?";
        json.needs_confirmation = true;
      } else if (!json.amount) {
        json.response = `How much to ${json.recipient}, please?`;
        json.needs_confirmation = true;
      } else if (!json.recipient) {
        json.response = `Send ₦${json.amount.toLocaleString()} to who, please?`;
        json.needs_confirmation = true;
      } else {
        json.response = `Send ₦${json.amount.toLocaleString()} to ${json.recipient}, please?`;
        json.needs_confirmation = false;
      }
    } else {
      json.response = "Say 'Send 5000 to Seyi', please";
      json.needs_confirmation = true;
    }

    console.log('[VOICEPAY] Parsed:', json);
    res.json(json);
  } catch (e) {
    console.error("[VOICEPAY] Parse error:", e);
    res.status(500).json({
      error: e.message,
      response: "Try again. Say: 'Send 5000 to Seyi'",
      needs_confirmation: true,
      intent: "unknown",
      confidence: 0
    });
  }
});

app.post("/create-payment-link", async (req, res) => {
  try {
    const { amount, recipient, userId } = req.body;
    const reference = `vp_${Date.now()}_${userId?.substring(0, 8)}`;

    await saveToMemory('transactions', reference, {
      userId, amount, recipient, status: 'demo_success', created_at: Date.now()
    });

    res.json({
      success: true,
      link: `https://voicepay-demo.com/pay/${reference}`,
      reference: reference,
      amount: amount,
      recipient: recipient,
      message: "Demo payment successful",
      mock: true
    });
  } catch (e) {
    res.status(500).json({ error: "Demo payment failed" });
  }
});

app.post("/verify-voice", upload.single('liveVoice'), async (req, res) => {
  res.json({ match: true, confidence: 95, message: "Voice verified - demo mode" });
});

app.post("/verify-pin", async (req, res) => {
  try {
    const { userId, pin } = req.body;
    if (!pin || pin.length!== 4) {
      return res.json({ success: false, message: "PIN must be 4 digits" });
    }
    const storedPin = await getFromMemory('pins', userId);
    const isValid = storedPin? storedPin.pin === pin : true;
    if (isValid) {
      console.log(`[PIN] Verified for user: ${userId}`);
      res.json({ success: true, message: "PIN verified" });
    } else {
      console.log(`[PIN] Failed for user: ${userId}`);
      res.json({ success: false, message: "Wrong PIN" });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: "PIN verification error" });
  }
});

app.post("/set-pin", async (req, res) => {
  try {
    const { userId, pin } = req.body;
    if (!pin || pin.length!== 4 ||!/^\d{4}$/.test(pin)) {
      return res.json({ success: false, message: "PIN must be 4 digits" });
    }
    await saveToMemory('pins', userId, { pin, createdAt: Date.now() });
    console.log(`[PIN] Set for user: ${userId}`);
    res.json({ success: true, message: "PIN saved successfully" });
  } catch (e) {
    res.status(500).json({ success: false, message: "Error saving PIN" });
  }
});

app.post("/duress-alert", async (req, res) => {
  const { uid } = req.body;
  await saveToMemory('users', uid, { locked: true, lastDuress: Date.now() });
  console.log(`🚨 DEMO DURESS: ${uid}`);
  res.json({ success: true, message: "Demo duress alert sent", fakeSuccess: true });
});

app.get("/get-user/:userId", async (req, res) => {
  const userData = await getFromMemory('users', req.params.userId);
  res.json(userData || { error: "User not found" });
});

// GENERATE VOICE RECEIPT - WORKS WITH QUERY PARAMS TOO
app.post("/generate-receipt", async (req, res) => {
  try {
    console.log('[RECEIPT DEBUG] Content-Type:', req.headers['content-type']);
    console.log('[RECEIPT DEBUG] Body:', req.body);
    console.log('[RECEIPT DEBUG] Query:', req.query);

    let { amount, recipient, language = 'yo' } = req.body;

    // Fallback to query params if body empty
    if (!amount) amount = req.query.amount;
    if (!recipient) recipient = req.query.recipient;
    if (!language) language = req.query.language;

    amount = Number(amount) || 5000;
    recipient = recipient || "Mama";
    language = String(language).toLowerCase().trim();

    const amountFormatted = amount.toLocaleString();
    console.log(`[RECEIPT] Final: amount:${amount} recipient:${recipient} lang:${language}`);

    const voices = {
      en: `Payment of ₦${amountFormatted} to ${recipient} completed successfully. Thank you for using VoicePay.`,
      yo: `Owo ₦${amountFormatted} ti lọ si ${recipient} ni aṣeyọri. Ṣeun fun lilo VoicePay.`,
      ha: `Kudi ₦${amountFormatted} sun tafi zuwa ${recipient} lafiya. Na gode da amfani da VoicePay.`,
      ig: `Ego ₦${amountFormatted} agaala nye ${recipient} nke ọma. Daalụ maka iji VoicePay.`,
      pcm: `Money ₦${amountFormatted} don reach ${recipient} finish. Thank you for using VoicePay.`
    };

    res.json({
      success: true,
      voice_text: voices[language] || voices.yo
    });
  } catch (e) {
    console.error("[RECEIPT ERROR]:", e);
    res.status(500).json({ error: "Receipt generation failed", details: e.message });
  }
});

// NEW: TEXT TO SPEECH ROUTE - ADDED AT THE END
app.post("/speak", async (req, res) => {
  try {
    const { text, language = 'yo' } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    console.log(`[TTS] Lang:${language} Text:${text.substring(0,40)}...`);

    // Map language codes for gTTS
    const langMap = { en: 'en', yo: 'yo', ha: 'ha', ig: 'ig', pcm: 'en' };
    const ttsLang = langMap[language] || 'en';

    const tts = new gTTS(text, ttsLang);
    const filename = path.join('/tmp', `voice_${Date.now()}.mp3`);

    tts.save(filename, function(err) {
      if (err) {
        console.error('[TTS ERROR]', err);
        return res.status(500).json({ error: "TTS failed" });
      }
      res.sendFile(filename, () => {
        fs.unlinkSync(filename); // Delete after send
      });
    });
  } catch (e) {
    console.error("[SPEAK ERROR]:", e);
    res.status(500).json({ error: "Speak failed" });
  }
});

app.get("/balance", async (req, res) => {
  try {
    const userId = req.query.userId;
    console.log(`[BALANCE] Fetch for user: ${userId}`);
    res.json({
      success: true,
      balance: 12545000,
      currency: "NGN",
      demo: true,
      message: "Demo mode balance"
    });
  } catch (e) {
    res.status(500).json({ error: "Balance fetch failed" });
  }
});

app.get("/get-transactions/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const allTx = Object.values(global.TRANSACTION_MEMORY);
    const userTx = allTx.filter(tx => tx.userId === userId);
    userTx.sort((a, b) => b.created_at - a.created_at);
    res.json({
      success: true,
      transactions: userTx.slice(0, 50),
      count: userTx.length
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

app.get("/", (req, res) => res.json({
  status: "VoicePay Demo Server Live",
  version: "1.5 - Body Parser Fix + TTS Audio",
  languages: ["English", "Yoruba", "Hausa", "Igbo", "Pidgin"],
  routes: ["/parse-voice-command", "/create-payment-link", "/verify-pin", "/set-pin", "/verify-voice", "/duress-alert", "/generate-receipt", "/speak", "/balance", "/get-transactions/:userId"],
  mode: "DEMO"
}));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[VOICEPAY DEMO] Server running on port ${PORT}`));
