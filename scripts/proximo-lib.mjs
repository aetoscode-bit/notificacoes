// =========================================================
// Seleção dos lembretes de "próximo atendimento" — lógica pura (testável em Node).
// Corrige o comportamento anterior: comparava hora UTC do servidor com a hora local do
// estabelecimento e só disparava se o minuto batesse exatamente (o cron do GitHub atrasa).
// =========================================================
const TZ_PADRAO = "America/Fortaleza";

function offsetMin(tz, date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** "yyyy-mm-dd" + "HH:mm" no relógio do estabelecimento → instante real. */
export function inicioEm(dataISO, hhmm, tz = TZ_PADRAO) {
  const [y, m, d] = dataISO.split("-").map(Number);
  const [h, mi] = (hhmm || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMin(tz, new Date(guess));
  let t = guess - off1 * 60000;
  const off2 = offsetMin(tz, new Date(t));
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

export const ATIVO = (a) => ["pendente", "confirmado"].includes(a.status || "confirmado");

/**
 * Devolve os agendamentos que devem receber o lembrete agora:
 * ativos (nunca cancelados/concluídos), ainda não notificados, que começam nos próximos
 * `antecedenciaMin` minutos. Quem já começou não é notificado.
 */
export function selecionarLembretes(agendamentos, now, { tzDe, antecedenciaDe }) {
  return agendamentos.filter((a) => {
    if (!ATIVO(a) || a.lembreteEnviado === true || !a.data || !a.horario) return false;
    const inicio = inicioEm(a.data, a.horario, tzDe(a.usuarioId));
    const falta = (inicio - now) / 60000;
    return falta > 0 && falta <= antecedenciaDe(a.usuarioId);
  });
}

export function textoLembrete(a) {
  return `Próximo atendimento às ${a.horario} — ${a.clienteNome || "Cliente"} — ${a.servicoNome || "Atendimento"}.`;
}
