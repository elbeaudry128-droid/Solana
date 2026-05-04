# Solana Sniper Bot (Raydium & Jupiter)

Ce bot surveille en temps réel la création de nouveaux pools de liquidité sur Raydium et exécute automatiquement un achat via l'agrégateur Jupiter.

## Fonctionnalités
- **Surveillance en temps réel** : Utilise les WebSockets pour détecter les nouveaux pools Raydium instantanément.
- **Exécution rapide** : Utilise Jupiter V6 pour trouver la meilleure route et exécuter le swap.
- **Configuration flexible** : Paramétrez votre montant d'achat, slippage et RPC via le fichier `.env`.
- **Logs détaillés** : Suivi précis de chaque étape avec `pino-pretty`.

## Installation

1.  **Cloner le projet** (ou copier les fichiers).
2.  **Installer les dépendances** :
    ```bash
    npm install
    ```
3.  **Configurer l'environnement** :
    Copiez le fichier `.env.example` vers `.env` et remplissez vos informations.
    ```bash
    cp .env.example .env
    ```
    *Note : Assurez-vous d'avoir un RPC de haute qualité (Helius, QuickNode, etc.) pour de meilleures performances.*

## Utilisation

### Mode Développement
Pour lancer le bot en mode développement avec `ts-node` :
```bash
npm run dev
```

### Mode Production
1.  **Compiler le projet** :
    ```bash
    npm run build
    ```
2.  **Lancer le bot** :
    ```bash
    npm start
    ```

## Structure du Projet
- `src/index.ts` : Point d'entrée principal.
- `src/core/monitor.ts` : Logique de détection des nouveaux pools.
- `src/core/executor.ts` : Logique d'exécution des swaps via Jupiter.

## Sécurité et Avertissement
- **Clé Privée** : Ne partagez jamais votre fichier `.env` contenant votre clé privée.
- **Risques** : Le trading de nouveaux tokens ("shitcoins") est extrêmement risqué. Vous pouvez perdre la totalité de votre capital.
- **Filtres** : Ce bot est une version de base. Pour une utilisation réelle, il est fortement recommandé d'ajouter des filtres de sécurité (vérification LP Burned, Mint Renounced, etc.).

## Améliorations Futures suggérées
- Intégration de **Jito** pour éviter le front-running.
- Module de **Vente Automatique** (Take Profit / Stop Loss).
- Filtres de sécurité avancés (RugCheck API).
