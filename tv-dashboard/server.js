import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Fuso (min) p/ Brasil = -180
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES || -180);

// Metas padrão
const DEFAULT_WEEKLY  = Number(process.env.WEEK_GOAL_BRL   || 2000000);
const DEFAULT_MONTHLY = Number(process.env.MONTH_GOAL_BRL  || 8000000);

const DATA_DIR = path.join(__dirname, "data");
const STORE    = path.join(DATA_DIR, "store.json");

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
async function ensureStore(){
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(STORE); }
  catch {
    const initial = {
      weeklyGoalBRL:  DEFAULT_WEEKLY,
      monthlyGoalBRL: DEFAULT_MONTHLY,
      entries: [],
      history: [],
      // PONTOS DE RESET DOS ARCOS (0 = nunca resetado)
      weekResetTs: 0,
      monthResetTs: 0,
    };
    await fs.writeFile(STORE, JSON.stringify(initial, null, 2), "utf8");
  }
}
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

// ===== ADMIN =====
app.get("/api/admin/state", async (_req, res) => {
  const s = await readStore();
  res.json({
    entries: s.entries.sort((a,b)=>a.ts-b.ts),
    weeklyGoal:  s.weeklyGoalBRL,
    monthlyGoal: s.monthlyGoalBRL
  });
});

app.post("/api/admin/add", async (req, res) => {
  const n = Number(req.body?.amount);

  const seller = (req.body?.seller || "").toString().slice(0, 60);
  const client = (req.body?.client || req.body?.note || "").toString().slice(0, 140);

  if (!Number.isFinite(n) || n === 0) {
    return res.status(400).json({ error: "Valor inválido" });
  }

  const updated = await writeStore(s => {
    const now = new Date();
    const dayName = now.toLocaleDateString("pt-BR", { weekday: "long" });

    const item = {
      id: mkId(),
      amount: Number(n.toFixed(2)),
      seller,
      client,
      note: client,
      ts: now.getTime(),        // timestamp em ms
      date: now.toISOString(),  // data completa ISO
      day: dayName              // nome do dia da semana
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
// Retorna a semana atual (segunda 00:00 até a próxima segunda 00:00) agrupada por dia
app.get("/api/week", async (req, res) => {
  const store = await readStore();

  // Base da semana: hoje ou ?date=YYYY-MM-DD (opcional)
  const base = req.query.date
    ? new Date(req.query.date + "T00:00:00")
    : new Date();

  // Normaliza para meia-noite local
  const atMidnight = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const b0 = atMidnight(base);

  // getDay(): 0=domingo, 1=segunda, ..., 6=sábado
  const dow = b0.getDay();
  const deltaToMonday = (dow === 0 ? -6 : 1 - dow);
  const monday = new Date(b0);
  monday.setDate(b0.getDate() + deltaToMonday);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);

  const startMs = monday.getTime();
  const endMs = nextMonday.getTime();

  // Ordem fixa
  const DAY_KEYS = ["segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"];
  const bucket = Object.fromEntries(DAY_KEYS.map(k => [k, { items: [], total: 0 }]));

  // Normaliza nome do dia
  const normalizeDay = (d) => {
    const name = new Date(d).toLocaleDateString("pt-BR", { weekday: "long" }).toLowerCase();
    if (name.startsWith("seg")) return "segunda";
    if (name.startsWith("ter")) return "terca";
    if (name.startsWith("qua")) return "quarta";
    if (name.startsWith("qui")) return "quinta";
    if (name.startsWith("sex")) return "sexta";
    if (name.startsWith("sáb") || name.startsWith("sab")) return "sabado";
    return "domingo";
    };

  // Filtra no intervalo e agrupa
  const inWeek = (store.entries || []).filter(
    (e) => typeof e.ts === "number" && e.ts >= startMs && e.ts < endMs
  );

  for (const e of inWeek) {
    const key = normalizeDay(e.ts);
    const client = (e.client || e.note || "").toString();
    const amount = Number(e.amount || 0);
    bucket[key].items.push({ client, amount });
    bucket[key].total += amount;
  }

  const subtotal = DAY_KEYS.reduce((acc, k) => acc + bucket[k].total, 0);

  res.json({
    range: {
      startISO: new Date(startMs).toISOString(),
      endISO:   new Date(endMs).toISOString()
    },
    days: bucket,    // dados por dia
    order: DAY_KEYS, // ordem para o front
    subtotal
  });
});


app.listen(PORT, () => console.log(`OK em http://localhost:${PORT}`));
