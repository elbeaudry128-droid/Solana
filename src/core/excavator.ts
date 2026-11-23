import axios from 'axios';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty' } });

export interface TokenSecurityReport {
  isSafe: boolean;
  risks: string[];
  score: number;
}

function reject(reason: string): TokenSecurityReport {
  return { isSafe: false, risks: [reason], score: Number.POSITIVE_INFINITY };
}

/** Un rapport incomplet n'est jamais interprété comme une preuve de sécurité. */
export function evaluateTokenReport(data: unknown, mint: string): TokenSecurityReport {
  if (!data || typeof data !== 'object') return reject('Rapport RugCheck invalide');
  const report = data as Record<string, unknown>;
  if (report.mint !== mint || typeof report.score !== 'number' ||
      !Number.isFinite(report.score) || report.score < 0 || !Array.isArray(report.risks)) {
    return reject('Rapport RugCheck incomplet ou mint incorrect');
  }
  if (!report.token || typeof report.token !== 'object') {
    return reject('Autorités du token absentes du rapport');
  }
  const token = report.token as Record<string, unknown>;
  // null est la seule valeur qui établit l'absence d'une autorité ; undefined est inconnu.
  const risks: string[] = [];
  if (token.mintAuthority !== null) risks.push('DANGER: Mint Authority active ou inconnue');
  if (token.freezeAuthority !== null) risks.push('DANGER: Freeze Authority active ou inconnue');
  for (const item of report.risks) {
    if (!item || typeof item !== 'object') return reject('Risque RugCheck invalide');
    const risk = item as Record<string, unknown>;
    if (typeof risk.name !== 'string' || !risk.name || typeof risk.level !== 'string') {
      return reject('Risque RugCheck incomplet');
    }
    const level = risk.level.toLowerCase();
    if (level !== 'warn' && level !== 'danger') return reject('Niveau de risque RugCheck inconnu');
    risks.push(`${level.toUpperCase()}: ${risk.name}`);
  }
  const score = report.score;
  return { isSafe: score < 1000 && !risks.some(r => r.startsWith('DANGER:')), risks, score };
}

type GetReport = (url: string) => Promise<{ data: unknown }>;

export class Excavator {
  private readonly rugCheckApi = 'https://api.rugcheck.xyz/v1';
  constructor(private readonly getReport: GetReport = url => axios.get(url, { timeout: 5000 })) {}

  /** Le rapport complet contient les autorités absentes du résumé. */
  public async analyzeToken(mint: string): Promise<TokenSecurityReport> {
    logger.info(`Excavator : analyse du token ${mint}...`);
    try {
      const response = await this.getReport(`${this.rugCheckApi}/tokens/${encodeURIComponent(mint)}/report`);
      return evaluateTokenReport(response.data, mint);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Erreur inconnue';
      logger.error(`Erreur Excavator pour ${mint}: ${message}`);
      return reject(`Erreur API ou token non indexé: ${message}`);
    }
  }
}
