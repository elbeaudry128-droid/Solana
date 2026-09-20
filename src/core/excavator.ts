import axios from 'axios';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

export interface TokenSecurityReport {
  isSafe: boolean;
  risks: string[];
  score: number;
}

export class Excavator {
  private rugCheckApi = 'https://api.rugcheck.xyz/v1';

  /**
   * Analyse un token via RugCheck API
   */
  public async analyzeToken(mint: string): Promise<TokenSecurityReport> {
    logger.info(`Excavator : Analyse du token ${mint}...`);

    try {
      // Utilisation de l'endpoint summary qui est plus léger et souvent plus stable
      const response = await axios.get(`${this.rugCheckApi}/tokens/${mint}/report/summary`);
      const data = response.data;

      const risks: string[] = [];
      let score = data.score || 0;

      if (data.risks) {
        data.risks.forEach((risk: any) => {
          risks.push(`${risk.level.toUpperCase()}: ${risk.name}`);
        });
      }

      // Vérifications manuelles basées sur les données du token
      const tokenData = data.token || {};
      const isMintRenounced = tokenData.mintAuthority === null || tokenData.mintAuthority === undefined;
      const isFreezeDisabled = tokenData.freezeAuthority === null || tokenData.freezeAuthority === undefined;

      if (!isMintRenounced) risks.push('WARN: Mint Authority non renoncée');
      if (!isFreezeDisabled) risks.push('DANGER: Freeze Authority activée');

      // Seuil de sécurité : score < 1000 et pas de risques de niveau DANGER
      const hasDanger = risks.some(r => r.startsWith('DANGER'));
      const isSafe = score < 1000 && !hasDanger;

      return {
        isSafe,
        risks,
        score
      };
    } catch (error: any) {
      // Si RugCheck échoue (ex: token trop récent), on peut soit bloquer, soit faire des vérifications on-chain basiques
      // Pour ce bot, on choisit la prudence : on bloque si l'analyse échoue
      logger.error(`Erreur Excavator pour ${mint}: ${error.message}`);
      return {
        isSafe: false,
        risks: [`Erreur API ou Token non indexé: ${error.message}`],
        score: 9999
      };
    }
  }
}
