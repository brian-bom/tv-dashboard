import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Em prod (Render): DATA_DIR=/data  -> disco persistente
// Em dev/local: cai no fallback ./data dentro do projeto
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE    = path.join(DATA_DIR, "store.json");

// garante que a pasta/arquivo existam
async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(STORE);
  } catch {
    const empty = { history: [], entries: [] };
    await fs.writeFile(STORE, JSON.stringify(empty, null, 2));
  }
}
ensureStore().catch(console.error);

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/debug/storage", async (req, res) => {
  try {
    const stat = await fs.stat(STORE);
    const content = await fs.readFile(STORE, "utf8");
    res.json({
      path: STORE,
      size_kb: (stat.size / 1024).toFixed(2),
      sample: content.slice(0, 200) // mostra início do arquivo
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fuso (min) p/ Brasil = -180
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES || -180);

// Metas padrão
const DEFAULT_WEEKLY  = Number(process.env.WEEK_GOAL_BRL   || 2000000);
const DEFAULT_MONTHLY = Number(process.env.MONTH_GOAL_BRL  || 8000000);


// ---------- datas ----------
const toLocal = (ts, offMin) => new Date(ts + offMin * 60000);
function startOfWeekTs(offMin){ // segunda
  const d = toLocal(Date.now(), offMin);
  const dow = (d.getUTCDay()+6)%7;
  d.setUTCDate(d.getUTCDate() - dow);
  d.setUTCHours(0,0,0,0);
  return d.getTime() - offMin*60000;
}
function startOfMonthTs(offMin){
  const d = toLocal(Date.now(), offMin);
  d.setUTCDate(1); d.setUTCHours(0,0,0,0);
  return d.getTime() - offMin*60000;
}
const sum  = arr => Number(arr.reduce((a,b)=>a+Number(b||0),0).toFixed(2));
const mkId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

// ---------- store ----------
async function readStore(){
  await ensureStore();
  let s = JSON.parse(await fs.readFile(STORE, "utf8") || "{}");
  if (!Array.isArray(s.entries)) s.entries = [];
  if (!Array.isArray(s.history)) s.history = [];
  if (!("weeklyGoalBRL"  in s)) s.weeklyGoalBRL  = DEFAULT_WEEKLY;
  if (!("monthlyGoalBRL" in s)) s.monthlyGoalBRL = DEFAULT_MONTHLY;
  if (!("weekResetTs"    in s)) s.weekResetTs    = 0;
  if (!("monthResetTs"   in s)) s.monthResetTs   = 0;
  return s;
}
async function writeStore(mutator){
  const s = await readStore();
  const updated = await mutator(s);
  await fs.writeFile(STORE, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}
const computeTotal = (entries) => sum(entries.map(e => e.amount));

// ---------- app ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

// ===== ADMIN =====
// util: formata YYYY-MM-DD (respeitando seu fuso se você já usa TZ_OFFSET_MIN)
function toDateStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

app.get("/api/admin/state", async (req, res) => {
  try {
    const s = await readStore(); // { history: [], entries: [] , ... }
    const qDate = (req.query.date || "").trim(); // YYYY-MM-DD opcional

    let dayEntries;
    if (qDate) {
      // pega do histórico tudo do dia solicitado
      dayEntries = (s.history || []).filter(e => e.date === qDate);
    } else {
      // mantém comportamento atual (lançamentos do “dia corrente” que você já guarda em entries)
      dayEntries = s.entries || [];
    }

    // ordem: mais recente no topo
    dayEntries.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    return res.json({
  entries: dayEntries,
  weeklyGoal: s.weeklyGoalBRL,
  monthlyGoal: s.monthlyGoalBRL
});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: "state failed" });
  }
});

app.post("/api/admin/add", async (req, res) => {
  const n = Number(req.body?.amount);

  const seller = (req.body?.seller || "").toString().slice(0, 60);
  const client = (req.body?.client || req.body?.note || "").toString().slice(0, 140);

  if (!Number.isFinite(n) || n === 0) {
    return res.status(400).json({ error: "Valor inválido" });
  }

  const updated = await writeStore(s => {
    const now = Date.now(); // timestamp real (UTC)
const pad = n => String(n).padStart(2, '0');

// Converte "now" para DATA LOCAL usando seu offset (ex.: -180 = Brasil)
const local = new Date(now + TZ_OFFSET_MIN * 60000);

// YYYY-MM-DD no fuso local
const dateStr = `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())}`;

// Nome do dia no fuso local (pt-BR)
const dayName = local.toLocaleDateString("pt-BR", { weekday: "long" });

const item = {
  id: mkId(),
  amount: Number(n.toFixed(2)),
  seller,
  client,
  note: client,
  ts: now,         // mantém o timestamp em ms (UTC)
  date: dateStr,   // <-- agora é "YYYY-MM-DD" do fuso local
  day: dayName
};

    s.entries.push(item);
    s.history.push(item);
    return s;
  });

  // <-- Isto faltava
  res.json({ success: true, totalEntries: computeTotal(updated.entries) });
}); // <-- E este fechamento também


app.put("/api/admin/update/:id", async (req, res) => {
  const id = req.params.id;
  const n = Number(req.body?.amount);
  const seller = (req.body?.seller || "").toString().slice(0, 60);
  const client = (req.body?.client || req.body?.note || "").toString().slice(0, 140);

  if (!Number.isFinite(n) || n === 0) {
    return res.status(400).json({ error:"Valor inválido" });
  }

  const updated = await writeStore(s => {
    const iDay = s.entries.findIndex(e=>e.id===id);
    const iHis = s.history.findIndex(e=>e.id===id);
    if (iDay === -1 && iHis === -1) throw new Error("ID não encontrado");

    const apply = (arr, idx) => {
      if (idx === -1) return;
      arr[idx].amount = Number(n.toFixed(2));
      arr[idx].seller = seller;                    // novo
      arr[idx].client = client;                    // novo
      arr[idx].note   = client;                    // compat
    };
    apply(s.entries, iDay);
    apply(s.history, iHis);
    return s;
  }).catch(err => ({ error: err.message }));

  if (updated.error) return res.status(404).json({ error: updated.error });
  res.json({ success:true });
});

app.delete("/api/admin/delete/:id", async (req, res) => {
  const id = req.params.id;
  const updated = await writeStore(s => {
    const bd = s.entries.length, bh = s.history.length;
    s.entries = s.entries.filter(e=>e.id!==id);
    s.history = s.history.filter(e=>e.id!==id);
    if (bd===s.entries.length && bh===s.history.length) throw new Error("ID não encontrado");
    return s;
  }).catch(err => ({ error: err.message }));
  if (updated.error) return res.status(404).json({ error: updated.error });
  res.json({ success:true });
});

// manter: limpa a LISTA do dia (não mexe em histórico nem arcos)
app.post("/api/reset", async (req, res) => {
  if (!req.body?.confirm) return res.status(400).json({ error:"Confirmação ausente" });
  const updated = await writeStore(s => { s.entries = []; return s; });
  res.json({ success:true });
});

// metas semanal e mensal
app.post("/api/set-goals", async (req, res) => {
  const w = Number(req.body?.weeklyGoalBRL);
  const m = Number(req.body?.monthlyGoalBRL);
  const updated = await writeStore(s => {
    if (Number.isFinite(w) && w>0) s.weeklyGoalBRL  = Math.round(w);
    if (Number.isFinite(m) && m>0) s.monthlyGoalBRL = Math.round(m);
    return s;
  });
  res.json({ success:true, weeklyGoal: updated.weeklyGoalBRL, monthlyGoal: updated.monthlyGoalBRL });
});

// ===== NOVO: reset de arcos =====
app.post("/api/reset-week", async (_req, res) => {
  const now = Date.now();
  const updated = await writeStore(s => { s.weekResetTs = now; return s; });
  res.json({ success:true, weekResetTs: updated.weekResetTs });
});

app.post("/api/reset-month", async (_req, res) => {
  const now = Date.now();
  const updated = await writeStore(s => { s.monthResetTs = now; return s; });
  res.json({ success:true, monthResetTs: updated.monthResetTs });
});

// ===== TV (Semanal + Mensal) =====
app.get("/api/summary", async (_req, res) => {
  const s = await readStore();
  const w0 = Math.max(startOfWeekTs(TZ_OFFSET_MIN),  s.weekResetTs || 0);
  const m0 = Math.max(startOfMonthTs(TZ_OFFSET_MIN), s.monthResetTs || 0);

  const weekEntries  = s.history.filter(e => e.ts >= w0);
  const monthEntries = s.history.filter(e => e.ts >= m0);

  const weekTotal  = computeTotal(weekEntries);
  const monthTotal = computeTotal(monthEntries);

  res.json({
    week:  { total: weekTotal,  goal: s.weeklyGoalBRL,  percentage: Number(((weekTotal  / s.weeklyGoalBRL)  * 100 || 0).toFixed(2)) },
    month: { total: monthTotal, goal: s.monthlyGoalBRL, percentage: Number(((monthTotal / s.monthlyGoalBRL) * 100 || 0).toFixed(2)) }
  });
});

// ===== WEEK TABLE API =====
// Semana baseada NO FUSO LOCAL (TZ_OFFSET_MIN). Ciclo: quarta → terça.
app.get("/api/week", async (req, res) => {
  const s = await readStore();
  const OFFSET = TZ_OFFSET_MIN * 60000; // ex.: -180 * 60k = -10800000

  // 1) Obter "meia-noite LOCAL" da data base
  let baseLocalMidnightMs;

  if (req.query.date) {
    // ?date=YYYY-MM-DD (interpreta como meia-noite LOCAL desse dia)
    const [y, m, d] = req.query.date.split("-").map(Number);
    // Date.UTC(y, m-1, d, 0,0,0) = meia-noite UTC desse YYYY-MM-DD
    // Para obter a meia-noite LOCAL em UTC ms, subtraímos o OFFSET
    baseLocalMidnightMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  } else {
    // sem query: usa "agora" no fuso LOCAL
    const nowLocal = new Date(Date.now() + OFFSET);
    const y = nowLocal.getUTCFullYear();
    const m = nowLocal.getUTCMonth();     // 0..11
    const d = nowLocal.getUTCDate();
    baseLocalMidnightMs = Date.UTC(y, m, d, 0, 0, 0);
  }

  // 2) Encontrar a QUARTA-FEIRA (local) da semana corrente
  // Transformamos baseLocalMidnightMs em Date "no espaço local":
  const baseLocal = new Date(baseLocalMidnightMs); // usa getUTC* por ser "localizado" pelo OFFSET
  const dowLocal = baseLocal.getUTCDay();          // 0=dom .. 3=qua
  const daysSinceWed = (dowLocal - 3 + 7) % 7;

  const wedLocal = new Date(baseLocalMidnightMs);
  wedLocal.setUTCDate(baseLocal.getUTCDate() - daysSinceWed);
  wedLocal.setUTCHours(0, 0, 0, 0);

  const nextWedLocal = new Date(wedLocal);
  nextWedLocal.setUTCDate(wedLocal.getUTCDate() + 7);

  // 3) Converter limites da SEMANA (definidos no fuso LOCAL) para UTC ms
  const startMs = wedLocal.getTime()   - OFFSET; // início da semana em UTC ms
  const endMs   = nextWedLocal.getTime() - OFFSET;

  // 4) Agrupar por dia LOCAL
  const DAY_KEYS = ["quarta", "quinta", "sexta", "segunda", "terca"];
  const bucket = Object.fromEntries(DAY_KEYS.map(k => [k, { items: [], total: 0 }]));

  const keyFromTs = (tsUtc) => {
    const d = new Date(tsUtc + OFFSET);   // “leva” para o fuso local
    const dow = d.getUTCDay();            // 0..6 já “local”
    if (dow === 1) return "segunda";
    if (dow === 2) return "terca";
    if (dow === 3) return "quarta";
    if (dow === 4) return "quinta";
    if (dow === 5) return "sexta";
    if (dow === 6) return "sabado";
    return "domingo";
  };

  // pegue do HISTÓRICO no intervalo da semana
  const inWeek = (s.history || []).filter(
    e => typeof e.ts === "number" && e.ts >= startMs && e.ts < endMs
  );

  for (const e of inWeek) {
    const k = keyFromTs(e.ts);
    if (!bucket[k]) continue; // ignora sáb/dom se não estão na grade
    const client = (e.client || e.note || "").toString();
    const amount = Number(e.amount || 0);
    bucket[k].items.push({ client, amount });
    bucket[k].total += amount;
  }

  const subtotal = Object.values(bucket).reduce((acc, d) => acc + (d.total || 0), 0);

  res.json({
    range: {
      // estes são UTC ms correspondentes às 00:00 LOCAL de quarta → terça seguintes
      startISO: new Date(startMs).toISOString(),
      endISO:   new Date(endMs).toISOString()
    },
    days: bucket,
    order: DAY_KEYS,
    subtotal
  });
});


app.listen(PORT, () => console.log(`OK em http://localhost:${PORT}`));
