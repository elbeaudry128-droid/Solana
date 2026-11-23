# Solana Sniper Bot — prototype d'observation

Ce prototype surveille les événements du programme Raydium V4 et interroge RugCheck. **Il n'est pas prêt pour la production ni pour engager des fonds. L'exécution réelle est désactivée dans cette version.** Un devis Jupiter cohérent ne prouve pas que la transaction retournée correspond bien au swap demandé : elle peut contenir des instructions supplémentaires ou nuisibles.

## Installation et observation

Avec Node.js 22 et npm :

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

`DRY_RUN=true` est le défaut, même en l'absence de cette variable. En observation, aucune clé privée ni clé Jupiter n'est nécessaire et le bot ne construit, ne signe et n'envoie **aucune transaction**. Il ne demande pas non plus de cotation Jupiter : ce n'est pas une simulation d'achat. Il se connecte néanmoins au RPC/WebSocket configuré et à RugCheck ; le RPC par défaut est celui du **mainnet** et les services peuvent observer les requêtes.

`npm run dev` lance également le bot en observation. `DRY_RUN=false` est refusé même si les clés sont fournies. Un verrou supplémentaire bloque les méthodes de signature et d'envoi des modules Jupiter et Jito ; aucune variable d'environnement ne le désactive. Ne partagez pas `.env` et n'utilisez jamais une clé contenant des fonds pour les tests.

## Configuration

Les booléens doivent être exactement `true` ou `false` ; les valeurs numériques sont des décimaux sans exposant ni suffixe. Les variables vides, autres que les clés ignorées en mode observation, sont rejetées.

| Variable | Sens et valeur par défaut |
|---|---|
| `DRY_RUN` | `true` : observation uniquement. `false` : refusé, mode réel désactivé. |
| `RPC_URL` | URL HTTP(S) du RPC ; mainnet public par défaut. |
| `WS_URL` | Facultative, URL WS(S) ; sinon dérivée du RPC. Vérifiez que RPC et WebSocket ciblent le même réseau. |
| `BUY_AMOUNT` | SOL par achat ; défaut `0.1`, strictement positif, jusqu'à 9 décimales et transmissible sans perte en lamports entiers sûrs. |
| `SLIPPAGE` | Pourcentage entre 0 et 100 inclus ; défaut `1`, jusqu'à 2 décimales, converti exactement en points de base (par exemple `1.25` = 125 bps). Une valeur élevée augmente fortement le risque. |
| `USE_JITO` | Défaut `false`. Configuration réservée à une future version : aucun envoi Jito n'est actif. |
| `JITO_TIP` | Pourboire en SOL, défaut `0.001`, non négatif et à 9 décimales au plus ; si Jito est activé, entre `0.000001` et `0.005` SOL inclus. Il s'ajoute aux coûts du swap. |
| `JITO_BLOCK_ENGINE_URL` | Hôte officiel Jito mainnet pris en charge ; défaut `frankfurt.mainnet.block-engine.jito.wtf`. |
| `PRIVATE_KEY` | Ignorée en observation ; aucune clé n'est requise. |
| `JUPITER_API_KEY` | Ignorée en observation ; aucune clé n'est requise. |

Les anciennes options `CHECK_IF_BURNED`, `CHECK_IF_RENOUNCED` et `MIN_LIQUIDITY` **ne sont pas implémentées** : leur présence, même à `false`, est maintenant rejetée. Supprimez-les de `.env`. `QUOTE_MINT` est limité à WSOL ; toute autre valeur est rejetée. Les contrôles de RugCheck ne remplacent pas ces filtres.

## Tests hors réseau

```bash
npm test
```

La commande compile puis exécute les tests avec `node --test`. Ils ne lancent pas le bot, ne contactent aucun service et n'envoient aucune transaction réelle. Certains tests des modules utilisent des clés et transactions factices créées localement avec des services simulés. Ils ne valident pas l'exécution sur chaîne. `npm run build` compile uniquement ; il ne lance pas le bot.

## Limites de sécurité et d'exécution

- L'analyse RugCheck rejette les rapports incomplets et les autorités actives ou inconnues, mais dépend d'un service externe : la liquidité, les LP et tous les autres risques ne sont pas vérifiés de manière exhaustive ni indépendamment sur chaîne. Aucune décision ne garantit la sécurité d'un token.
- La détection décode seulement une variante d'instruction Raydium V4 et peut manquer des pools. Le dédoublonnage local ne garantit pas l'absence d'achats concurrents ni la persistance après redémarrage.
- Il n'existe pas de plafond global de dépenses ou de nombre d'achats, ni de garde-fous de production, d'audit indépendant ou de stratégie de reprise robuste.
- Les modules Jupiter et Jito restent désactivés. Le code expérimental Jito intègre le pourboire dans la transaction et distingue soumission et confirmation, mais cela ne prouve pas qu'un swap soit économiquement correct.
- Avant toute activation future, il faudra vérifier indépendamment la transaction et ses tables d'adresses : programmes, comptes, montants, token de destination, montant minimal reçu, frais et instructions supplémentaires. Une simulation ou une instruction Jupiter présente ne suffisent pas. Il faudra aussi auditer les dépendances et ajouter des limites de risque.
- Le code expérimental utilise l'API Jupiter Swap V1, qui n'est plus activement maintenue ; la migration vers V2 et ses nouveaux contrats doit être testée séparément.

L'audit npm des seules dépendances de production du 23 novembre 2026 signale encore 7 vulnérabilités (dont 3 élevées), après retrait de deux dépendances inutilisées et application des correctifs compatibles. Certaines corrections restantes proposées impliquent des changements incompatibles et exigent une analyse de compatibilité ; ne considérez pas le projet comme sûr sur la seule base des tests.
