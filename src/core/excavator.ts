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
   * Analyse un token via RugCheck API et des vérifications personnalisées
   */
  public async analyzeToken(mint: string): Promise<TokenSecurityReport> {
    logger.info(`Excavator : Analyse du token ${mint}...`);
    
    try {
      const response = await axios.get(`${this.rugCheckApi}/tokens/${mint}/report/summary`);
      const data = response.data;

      const risks: string[] = [];
      let score = 0;

      // Analyse des risques retournés par RugCheck
      if (data.risks) {
        data.risks.forEach((risk: any) => {
          if (risk.level === 'danger') {
            risks.push(`DANGER: ${risk.name} - ${risk.description}`);
          } else if (risk.level === 'warn') {
            risks.push(`WARN: ${risk.name}`);
          }
        });
      }

      // Vérifications spécifiques
      const isMintRenounced = data.token?.mintAuthority === null;
      const isFreezeDisabled = data.token?.freezeAuthority === null;
      const lpBurned = data.lpLocked === 100 || data.lpBurned === 100;

      if (!isMintRenounced) risks.push('Mint Authority non renoncée');
      if (!isFreezeDisabled) risks.push('Freeze Authority activée');
      if (!lpBurned) risks.push('Liquidité non brûlée/bloquée');

      score = data.score || 0;

      // Un token est considéré "Safe" si le score est bas et qu'il n'y a pas de risques critiques
      const isSafe = score < 500 && risks.filter(r => r.startsWith('DANGER')).length === 0;

      return {
        isSafe,
        risks,
        score
      };
    } catch (error) {
      logger.error(`Erreur Excavator lors de l'analyse de ${mint}: ${error}`);
      return { isSafe: false, risks: ['Erreur d\'analyse'], score: 9999 };
    }
  }
}
