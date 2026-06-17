import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import multer from "multer";

dotenv.config();
const app = express();

app.use(cors({
  origin: ['https://harpstech-ng.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// DEMO MEMORY STORAGE - NO DATABASE NEEDED
global.VOICE_MEMORY = {};
global.TRANSACTION_MEMORY = {};
global.DURESS_MEMORY = {};

async function saveToMemory(collection, docId, data) {
  if (collection === 'users') global.VOICE_MEMORY[docId] = {...global.VOICE_MEMORY[docId],...data };
  else if (collection === 'transactions') global.TRANSACTION_MEMORY[docId] = data;
  else if (collection === 'duress_logs') global.DURESS_MEMORY[docId] = data;
  return;
}

async function getFromMemory(collection, docId) {
  if (collection === 'users') return global.VOICE_MEMORY[docId] || null;
  if (collection === 'transactions') return global.TRANSACTION_MEMORY[docId] || null;
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

// 5 LANGUAGES AI PROMPT - THIS IS THE WOW FACTOR FOR OPAY
app.post("/parse-voice-command", async (req, res) => {
  try {
    const { transcript, userId } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript is required" });

    console.log('[VOICEPAY] User said:', transcript);

    // DURESS CHECK
    let duress = false;
    if (userId) {
      const userData = await getFromMemory('users', userId);
      const duressPhrase = userData?.duressPhrase || 'transfer urgent money';
      if (transcript.toLowerCase().includes(duressPhrase.toLowerCase())) {
        duress = true;
        console.log('[DURESS] Detected for user:', userId);
      }
    }

    // 5 LANGUAGE SYSTEM PROMPT - ENGLISH + YORUBA + HAUSA + IGBO + PIDGIN
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

Return ONLY JSON: {"intent":"transfer|buy_airtime|check_balance|chitchat|unknown","amount":number,"recipient":string,"language_detected":"en|yo|ha|ig|pcm","confidence":0-1,"response":"short respectful reply under 12 words","needs_confirmation":boolean}

EXAMPLES:
"Ehhm send five to my daughter" → {"intent":"transfer","amount":5000,"recipient":"daughter","confidence":0.7,"response":"Send ₦5,000 to your daughter, please?","needs_confirmation":true,"language_detected":"en"}
"Fi 2k ranṣẹ" → {"intent":"transfer","amount":2000,"recipient":null,"confidence":0.6,"response":"Send ₦2,000 to who, please?","needs_confirmation":true,"language_detected":"yo"}
"Tura dubu biyu" → {"intent":"transfer","amount":2000,"recipient":null,"confidence":0.6,"response":"Send ₦2,000 to who, please?","needs_confirmation":true,"language_detected":"ha"}
"Ziga puku na Chioma" → {"intent":"transfer","amount":1000,"recipient":"Chioma","confidence":0.6,"response":"Send ₦1,000 to Chioma, please?","needs_confirmation":true,"language_detected":"ig"}
"Bawo ni" → {"intent":"chitchat","confidence":1.0,"response":"Good morning. How can I help?","language_detected":"yo"}`;

    const text = await chat(`${SYSTEM_PROMPT}\n\nUser speech: "${transcript}"`);
    console.log('[VOICEPAY] Groq raw:', text);
    let json = extractJSON(text.trim());
    json.duress = duress;

    // AUTO-RESPONSE LOGIC - THIS TEXT GOES TO FRONTEND TTS
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

// DEMO PAYMENT LINK - RETURNS LINK FOR FRONTEND
app.post("/create-payment-link", async (req, res) => {
  try {
    const { amount, recipient, userId } = req.body;
    const reference = `vp_${Date.now()}_${userId?.substring(0, 8)}`;

    await saveToMemory('transactions', reference, {
      userId, amount, recipient, status: 'demo_success', created_at: Date.now()
    });

    res.json({
      success: true,
      link: `https://voicepay-demo.com/pay/${reference}`, // FRONTEND NEEDS THIS
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

// VOICE VERIFY - DEMO MODE
app.post("/verify-voice", upload.single('liveVoice'), async (req, res) => {
  res.json({ match: true, confidence: 95, message: "Voice verified - demo mode" });
});

// DURESS ALERT
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

app.get("/", (req, res) => res.json({
  status: "VoicePay Demo Server Live",
  version: "1.0 - 5 Languages + Demo Mode",
  languages: ["English", "Yoruba", "Hausa", "Igbo", "Pidgin"],
  mode: "DEMO"
}));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[VOICEPAY DEMO] Server running on port ${PORT}`));
