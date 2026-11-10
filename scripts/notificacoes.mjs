// =========================================================
// AgendaAI — Notificações automáticas SEM Cloud Functions
// =========================================================
// Este script faz o mesmo trabalho que estava em functions/index.js,
// mas roda fora do Firebase — por exemplo, num workflow agendado do
// GitHub Actions (grátis) — evitando a exigência do plano Blaze.
//
// Ele usa o Firebase Admin SDK com uma chave de conta de serviço
// (Service Account), que só precisa de acesso ao Firestore/Cloud
// Messaging — isso NÃO exige o plano pago, pois não é uma Cloud
// Function, é só um script comum lendo/escrevendo no Firestore.
//
// Como configurar (grátis):
// 1. No Firebase Console → Configurações do projeto → Contas de serviço
//    → "Gerar nova chave privada". Isso baixa um .json.
// 2. No seu repositório GitHub → Settings → Secrets and variables →
//    Actions → New repository secret:
//      Nome: FIREBASE_SERVICE_ACCOUNT
//      Valor: cole o conteúdo INTEIRO do .json baixado.
// 3. O workflow em .github/workflows/notificacoes.yml já está pronto
//    para rodar a cada 5 minutos automaticamente.
// =========================================================

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { selecionarLembretes, textoLembrete } from "./proximo-lib.mjs";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
  console.error("Faltou a variável de ambiente FIREBASE_SERVICE_ACCOUNT.");
  process.exit(1);
}

const serviceAccount = JSON.parse(serviceAccountJson);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatHorarioCurto(data, horario) {
  const hoje = new Date();
  const amanha = new Date(hoje);
  amanha.setDate(hoje.getDate() + 1);
  if (data === toISODate(hoje)) return `hoje às ${horario}`;
  if (data === toISODate(amanha)) return `amanhã às ${horario}`;
  const [, m, d] = data.split("-");
  return `${d}/${m} às ${horario}`;
}

/** Envia notificação para todos os dispositivos cadastrados de um profissional. */
async function notifyUsuario(usuarioId, { title, body, tag, url }) {
  const userSnap = await db.collection("usuarios").doc(usuarioId).get();
  const tokens = userSnap.exists ? userSnap.data().fcmTokens || [] : [];
  if (!tokens.length) { console.log(`Sem aparelho cadastrado para ${usuarioId}: nada enviado.`); return 0; }

  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { tag: tag || "agendaai", url: url || "/agenda.html" },
    webpush: { fcmOptions: { link: url || "/agenda.html" } },
  });

  console.log(`Envio "${title}": ${response.successCount} ok, ${response.failureCount} falha(s).`);
  const invalidTokens = [];
  response.responses.forEach((r, idx) => {
    if (!r.success) console.log("  falha FCM:", r.error?.code, r.error?.message);
    if (!r.success && ["messaging/invalid-registration-token", "messaging/registration-token-not-registered"].includes(r.error?.code)) {
      invalidTokens.push(tokens[idx]);
    }
  });
  if (invalidTokens.length) {
    const remaining = tokens.filter((t) => !invalidTokens.includes(t));
    await db.collection("usuarios").doc(usuarioId).update({ fcmTokens: remaining });
  }
  return response.successCount;
}

async function temAparelho(usuarioId) {
  const u = await db.collection("usuarios").doc(usuarioId).get();
  return u.exists && (u.data().fcmTokens || []).length > 0;
}

// =========================================================
// 1) Novo agendamento — agendamentos ainda não notificados
// =========================================================
async function checarNovosAgendamentos() {
  const snap = await db.collection("agendamentos")
    .where("notificadoNovo", "==", false)
    .limit(200).get();

  await Promise.all(snap.docs.map(async (d) => {
    const a = d.data();
    if (!a.usuarioId || a.status === "cancelado") return;
    await notifyUsuario(a.usuarioId, {
      title: "AgendaAI — Novo agendamento!",
      body: `${a.clienteNome} agendou ${a.servicoNome} para ${formatHorarioCurto(a.data, a.horario)}.`,
      tag: "novo-agendamento",
      url: "/agenda.html",
    });
    await d.ref.update({ notificadoNovo: true });
  }));
}

// =========================================================
// 2) Cancelamentos ainda não notificados
// =========================================================
async function checarCancelamentos() {
  const snap = await db.collection("agendamentos")
    .where("status", "==", "cancelado")
    .where("notificadoCancelamento", "==", false)
    .limit(200).get();

  await Promise.all(snap.docs.map(async (d) => {
    const a = d.data();
    if (!a.usuarioId) return;
    await notifyUsuario(a.usuarioId, {
      title: "AgendaAI — Cancelamento",
      body: `${a.clienteNome} cancelou o atendimento de ${formatHorarioCurto(a.data, a.horario)}.`,
      tag: "cancelamento",
      url: "/agenda.html",
    });
    await d.ref.update({ notificadoCancelamento: true });
  }));
}

// =========================================================
// 3) Reagendamentos ainda não notificados
//    (agenda.js marca `reagendado: true` ao reagendar)
// =========================================================
async function checarReagendamentos() {
  const snap = await db.collection("agendamentos")
    .where("reagendado", "==", true)
    .where("notificadoReagendamento", "==", false)
    .limit(200).get();

  await Promise.all(snap.docs.map(async (d) => {
    const a = d.data();
    if (!a.usuarioId || a.status === "cancelado") return;
    await notifyUsuario(a.usuarioId, {
      title: "AgendaAI — Reagendamento",
      body: `${a.clienteNome} reagendou para ${formatHorarioCurto(a.data, a.horario)}.`,
      tag: "reagendamento",
      url: "/agenda.html",
    });
    await d.ref.update({ notificadoReagendamento: true });
  }));
}

// =========================================================
// 4) Lembrete — 30 minutos antes de cada atendimento confirmado
// =========================================================
async function checarLembretes() {
  const now = new Date();
  // Datas candidatas em UTC ±1 dia cobrem qualquer fuso do Brasil; o filtro fino é feito por fuso do estabelecimento.
  const dia = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);
  const snap = await db.collection("agendamentos").where("data", "in", [dia(-1), dia(0), dia(1)]).get();
  const ags = snap.docs.map((d) => ({ ref: d.ref, ...d.data() }));

  // Preferências e fuso por estabelecimento (cache simples).
  const ids = [...new Set(ags.map((a) => a.usuarioId))];
  const prefs = {};
  await Promise.all(ids.map(async (uid) => {
    const [u, c] = await Promise.all([db.collection("usuarios").doc(uid).get(), db.collection("configuracoes").doc(uid).get()]);
    const n = u.exists ? u.data().notificacoes || {} : {};
    prefs[uid] = {
      ativo: n.proximoAtendimento !== false,           // o profissional pode desativar nas Configurações
      antecedencia: Number(n.antecedenciaMin) > 0 ? Number(n.antecedenciaMin) : 30,
      tz: (c.exists && c.data().fusoHorario) || "America/Fortaleza",
    };
  }));

  const devidos = selecionarLembretes(ags.filter((a) => prefs[a.usuarioId]?.ativo), now, {
    tzDe: (uid) => prefs[uid].tz,
    antecedenciaDe: (uid) => prefs[uid].antecedencia,
  });

  console.log(`Lembretes: ${ags.length} agendamento(s) próximos analisados, ${devidos.length} devido(s).`);
  for (const a of devidos) {
    // Sem aparelho cadastrado: NÃO consome o aviso (ele será enviado quando o celular for ativado).
    if (!(await temAparelho(a.usuarioId))) { console.log(`Lembrete pendente (sem aparelho cadastrado): ${a.clienteNome} ${a.horario}`); continue; }
    // Marca ANTES de enviar: se o envio falhar, o cron seguinte não repete (evita duplicidade).
    await a.ref.update({ lembreteEnviado: true });
    await notifyUsuario(a.usuarioId, {
      title: "Agende Já — Próximo atendimento",
      body: textoLembrete(a),
      tag: "proximo-atendimento",
      url: "/agenda.html",
    });
  }
}

// =========================================================
// 5) Agenda cheia amanhã — avisa uma vez por dia (perto das 19h)
// =========================================================
/** Expediente do dia respeitando "horários personalizados" (se ativos). Retorna null se fechado. */
function configDoDia(config, diaSemana) {
  const custom = config.usarHorariosPersonalizados === true ? config.horariosPorDia?.[diaSemana] : null;
  if (!custom) {
    return (config.diasTrabalhados || ["seg", "ter", "qua", "qui", "sex"]).includes(diaSemana) ? config : null;
  }
  if (custom.ativo !== true) return null;
  return {
    ...config,
    horaInicio: custom.horaInicio || config.horaInicio,
    horaFim: custom.horaFim || config.horaFim,
    almocoInicio: custom.almocoInicio || "",
    almocoFim: custom.almocoFim || "",
  };
}

function calcularSlotsDisponiveis(config) {
  const toMinutes = (hhmm) => { const [h, m] = (hhmm || "0:0").split(":").map(Number); return h * 60 + m; };
  const inicio = toMinutes(config.horaInicio || "09:00");
  const fim = toMinutes(config.horaFim || "18:00");
  const almocoInicio = config.almocoInicio ? toMinutes(config.almocoInicio) : null;
  const almocoFim = config.almocoFim ? toMinutes(config.almocoFim) : null;
  const intervalo = config.intervaloAtendimentos ?? 10;
  const duracaoMedia = 30;
  const step = duracaoMedia + intervalo;
  let total = 0;
  for (let t = inicio; t + duracaoMedia <= fim; t += step) {
    if (almocoInicio !== null && almocoFim !== null && t < almocoFim && t + duracaoMedia > almocoInicio) continue;
    total++;
  }
  return total;
}

async function checarAgendaCheia() {
  const now = new Date();
  // O runner do GitHub Actions roda em UTC — convertemos para o horário de Brasília
  // para só disparar este aviso a partir das 19h locais.
  const horaBrasilia = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(now)
  );
  if (horaBrasilia < 19) return;

  const amanha = new Date(now);
  amanha.setDate(amanha.getDate() + 1);
  const amanhaISO = toISODate(amanha);
  const diaSemana = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][amanha.getDay()];

  const usuariosSnap = await db.collection("configuracoes").get();

  await Promise.all(usuariosSnap.docs.map(async (configDoc) => {
    const usuarioId = configDoc.id;
    const config = configDoc.data();
    if (config[`avisoAgendaCheia_${amanhaISO}`]) return; // já avisado hoje

    const cfgDia = configDoDia(config, diaSemana);
    if (!cfgDia) return; // não trabalha amanhã

    const totalSlots = calcularSlotsDisponiveis(cfgDia);
    if (totalSlots === 0) return;

    const agendamentosSnap = await db.collection("agendamentos")
      .where("usuarioId", "==", usuarioId)
      .where("data", "==", amanhaISO)
      .where("status", "==", "confirmado")
      .get();

    if (agendamentosSnap.size >= totalSlots) {
      await notifyUsuario(usuarioId, {
        title: "AgendaAI — Agenda cheia",
        body: "Sua agenda de amanhã está completa.",
        tag: "agenda-cheia",
        url: "/agenda.html",
      });
      await configDoc.ref.update({ [`avisoAgendaCheia_${amanhaISO}`]: true });
    }
  }));
}

async function main() {
  await checarNovosAgendamentos().catch((e) => console.error("novos:", e.message));
  await checarCancelamentos().catch((e) => console.error("cancelamentos:", e.message));
  await checarReagendamentos().catch((e) => console.error("reagendamentos:", e.message));
  await checarLembretes().catch((e) => console.error("lembretes:", e.message));
  await checarAgendaCheia().catch((e) => console.error("agenda cheia:", e.message));
  console.log("Verificação concluída.");
}

main();
