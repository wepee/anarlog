# Modifications de ce fork

Ce document recense tout ce qui diverge de `fastrepl/anarlog`, pour pouvoir
réappliquer ou abandonner chaque changement après une mise à jour upstream.

Chaque modification dans le code est marquée par un commentaire `[fork]` afin
d'être retrouvée par recherche :

```bash
grep -rn "\[fork\]" --include="*.rs" --include="*.tsx" --include="*.ts" .
```

## 1. Compatibilité macOS 27 / SDK 27

Sans ces trois correctifs, le dépôt **ne compile pas** sur un Mac équipé du
SDK 27. Ce sont des corrections de compatibilité, pas des choix : elles
devraient disparaître quand upstream mettra ses dépendances à jour, et
méritent d'être proposées en amont.

| Fichier | Changement | Raison |
|---|---|---|
| `Cargo.toml` | `swift-rs` → `fd82965` (1.0.8) | les versions antérieures ignorent le nouveau layout de sortie de SwiftPM (`out/Products/Debug`) |
| `rust-toolchain.toml` | `1.94.0` → `stable` | rustc 1.94 rend les proc-macros inchargeables dès que `MACOSX_DEPLOYMENT_TARGET` est défini |
| `plugins/permissions/swift/check-permissions.swift` | `+ import ApplicationServices` | `AXIsProcessTrusted` n'est plus exposé par import transitif |

## 2. Vie privée

Aucune donnée d'usage ni rapport de crash ne quitte la machine.

| Fichier | Changement |
|---|---|
| `plugins/analytics/src/lib.rs` | client analytics construit sans backend PostHog |
| `plugins/analytics/src/ext.rs` | `APP_VERSION` devient optionnel (repli sur la version du package) |
| `apps/desktop/src-tauri/src/lib.rs` | Sentry retiré (plus de client, plus de plugin) |
| `apps/desktop/src/settings/privacy/index.tsx` | interrupteurs PostHog et rapports d'erreur retirés (ils ne pilotaient plus rien) |
| `crates/analytics/src/lib.rs` | puits PostHog supprimé (`posthog-rs` retiré) : chaque appel journalise `analytics_backend_unavailable` et s'arrête là |
| `plugins/tracing`, `crates/listener-core`, `crates/user-error` | couche `sentry` du tracing, contexte de session Sentry et nettoyage des événements Sentry retirés : sans client, ils ne faisaient rien |
| `apps/cli/src/main.rs` | rapports d'erreur Sentry du CLI retirés (`error_reporting.rs` supprimé) |

Note : Sentry était déjà inactif sans `SENTRY_DSN` au build (`option_env!`).
Le retrait explicite sert surtout à supprimer la dépendance du build.

## 2 bis. Canal de mise à jour

Le fork a son propre canal, servi par ses Releases GitHub. `Updater2::check()`
et sa boucle native (30 min) sont donc rétablis à l'identique d'upstream ; ce
qui change est *où* ils regardent et *quelle clé* ils acceptent.

| Fichier | Changement |
|---|---|
| `apps/desktop/src-tauri/tauri.conf.json` | `pubkey` remplacée par la clé minisign du fork |
| `apps/desktop/src-tauri/tauri.conf.stable.json` | `active: true`, endpoint → `github.com/wepee/anarlog/releases/latest/download/latest.json` |
| `apps/desktop/src-tauri/tauri.conf.stable-macos.json` | même endpoint pour la variante macOS |
| `apps/desktop/src-tauri/tauri.conf.nightly*.json` | `active: false` — le fork ne publie pas de nightly |
| `.github/workflows/fork_release.yaml` | construit, signe et publie la Release qui alimente cet endpoint |

Le point important : `plugins.updater.active` ne pilote que la génération des
artefacts au build, pas les appels runtime. Ce qui empêche réellement une
mise à jour upstream de s'installer par-dessus ce fork, c'est la `pubkey` —
un artefact signé par la clé d'upstream est rejeté à la vérification. La clé
privée correspondante vit dans le secret GitHub `TAURI_SIGNING_PRIVATE_KEY`
du dépôt ; sans elle, plus aucune mise à jour ne peut être publiée.

## 2 ter. Un seul élément dans le trousseau

Upstream range chaque secret dans son propre élément du trousseau macOS :
clés API, identifiants d'import, et chaque échantillon d'empreinte vocale.
Un élément n'autorise que la signature de code qui l'a créé. Or les builds
du fork sont signés ad-hoc, avec une signature qui change à chaque build :
chaque élément redemandait donc l'accès séparément. Le nettoyage des empreintes
expirées, lancé au démarrage, suffisait à enchaîner des dizaines de demandes.

| Fichier | Changement |
|---|---|
| `plugins/store2/src/vault.rs` | coffre : secrets chiffrés (XChaCha20-Poly1305) dans `secure-store.vault.json`, clé maîtresse dans un seul élément du trousseau |
| `plugins/store2/src/commands.rs` | lecture coffre d'abord ; un ancien élément est lu une dernière fois puis migré ; suppressions dans le trousseau sans interaction (`SecKeychainSetUserInteractionAllowed`) |

Il reste au plus une demande par nouveau build, pour la clé maîtresse. Les
empreintes candidates (`voiceprint_candidates`) ne sont migrées que si le
trousseau les livre sans demander. Si la clé maîtresse est refusée, le
comportement d'origine, un élément par secret, reprend.

## 3. Déverrouillage des fonctions Pro

Une seule ligne, volontairement : `isPro: true` dans le contexte de
facturation (`apps/desktop/src/auth/billing.tsx`). Tout le reste du fichier est
identique à upstream.

Cela déverrouille l'interface. Les fonctions **locales** (dictée, dictionnaire,
transcription, intelligence) deviennent réellement utilisables ; celles qui
dépendent d'un serveur (sync, partage, IA hébergée) restent inopérantes — leur
disponibilité se décide côté serveur.

Les écrans Billing, Teams et Sync sont retirés du menu et du routage, mais
**leurs fichiers sont conservés** : modifier deux fichiers crée moins de
conflits que supprimer huit.

## 4. Allègement du build

Plugins retirés de `apps/desktop/src-tauri/Cargo.toml`, de `src/lib.rs` et de
`capabilities/default.json` :

| Plugin | Gain | Statut upstream |
|---|---|---|
| `git` | ~50 crates (`gix`) | déclaré mais **jamais monté** — code mort |
| `screen` | ~17 dépendances | déclaré mais **jamais monté** — code mort |
| `bedrock` | ~27 crates (`aws-*`) | actif ; inutile hors AWS Bedrock |
| `sentry` | ~11 crates | actif ; voir section 2 |
| `updater` (officiel Tauri) | — | actif ; inutile sur un fork |

**⚠️ `updater2` doit rester monté.** Son retrait fait paniquer `tauri-specta`
au démarrage (`Event update-available-event not found in registry!`) : le
plugin expose un événement que le reste de l'application attend. L'app se
termine alors avant d'ouvrir sa fenêtre.

La barre de devtools est également retirée (`apps/desktop/src/main/shell-frame.tsx`),
elle était activée en dur par le mode debug.

Seconde passe : plugins montés mais jamais appelés (aucun import côté front,
aucune commande `plugin:<nom>|…`, aucun crate Rust qui en dépend), retirés de la
même façon et supprimés du dépôt :

| Plugin | Gain | Ce qu'il faisait |
|---|---|---|
| `js` | 13 crates (`rquickjs`, moteur QuickJS en C) | commande `eval`, jamais appelée |
| `overlay`, `audio-priority`, `path2`, `messenger`, `mcp` | 1 à 2 crates chacun | commandes jamais appelées ; `mcp` n'exportait que des types, `messenger` qu'un `ping` |

Dépendances de build mortes ou remplaçables :

| Changement | Gain |
|---|---|
| `plugins/misc/build.rs` : `git rev-parse` au lieu de `vergen-gix` | 64 crates (`gix`), compilés à chaque build pour un seul SHA |
| `sentry` retiré (voir section 2) | 12 crates |
| `posthog-rs` retiré (voir section 2) | 1 crate |
| dépendances déclarées mais jamais utilisées (`cargo shear`) | une soixantaine d'entrées, surtout des dev-dependencies |

Crates orphelins supprimés : ils ne servaient qu'à `apps/api/`, `apps/stripe/`
et `apps/mobile/`, déjà retirés, mais restaient membres du workspace
(`crates/*`), donc compilés par `cargo test --workspace`, clippy et
rust-analyzer : tous les `crates/api-*`, `llm-proxy`, `transcribe-proxy`,
`nango`, `loops`, `supabase-storage`, `slack-web`, `linear`, `exa`, `jina`,
`google-mail`, `pyannote-cloud`, `mcp`, `attachment-sync-core`, `s3`,
`mobile-bridge`, `uniffi-bindgen` (et `packages/mobile-bridge-rn`), plus les
plugins `bedrock` et `attachment-sync`. Ils emportaient notamment `async-stripe`,
`aws-sdk-*` et `uniffi`. Tous sont listés dans `branding/removed-paths.txt` pour
que `scripts/merge-upstream.sh` réapplique la suppression.

Restent volontairement : `chrome-native-host` (sidecar livré avec l'app),
`meeting-capture` (utilisé par `enterprise/`), et les grosses dépendances qui
servent : export (`typst`), recherche (`tantivy`), calendrier, `api-client`.

## 4 bis. Archivage des enregistrements

Upstream ne laisse plus choisir où vivent les enregistrements (fastrepl/anarlog#7723) : tout
reste dans le dossier de l'app. Le fork ajoute à la place un archivage, sans
toucher à ce choix : juste après la réunion (une fois la transcription faite)
ou passé un délai (1 jour à 1 mois), l'audio d'une réunion
est copié dans un dossier choisi par l'utilisateur, typiquement iCloud Drive,
et le fichier local est remplacé par un lien symbolique. La lecture, les
pics d'onde et la retranscription suivent ce lien sans le savoir.

| Fichier | Changement |
|---|---|
| `crates/fs-sync-core/src/audio/archive.rs` | copie vérifiée (date de modification conservée pour le cache des pics), remplacement atomique par un lien ; disponibilité (`SF_DATALESS`), téléchargement à la demande, sélection des fichiers à libérer |
| `crates/fs-sync-core/src/audio/mod.rs` | supprimer un audio archivé supprime aussi le fichier archivé |
| `plugins/fs-sync/src/{ext,commands}.rs` | `archive_session_audio_locked` ; commandes `audio_availability` et `audio_download` ; `audio_path` renvoie le chemin résolu |
| `plugins/transcription/src/audio_retention.rs` | passe d'archivage toutes les 2 min, puis éviction iCloud (`brctl evict`) |
| `apps/desktop/src/audio-player/{provider,timeline}.tsx` | un audio retiré du Mac n'est pas chargé à l'ouverture de la note : « In iCloud », puis téléchargement au clic sur lecture |
| `apps/desktop/src/settings/general/audio-archive.tsx` | réglage dans Réunions → Audio |

Copier dans iCloud Drive ne libère rien tant que macOS garde la copie
locale, et il ne l'évince que sous pression disque : d'où l'éviction
explicite, dix minutes après la copie (le temps du téléversement ; `brctl`
refuse tant qu'il n'est pas fini et l'éviction est retentée). Un audio écouté
il y a moins de 30 minutes n'est pas évincé. Un dossier d'archive absent
(disque débranché) suspend l'archivage au lieu de recréer le dossier en local.

Le lecteur d'upstream télécharge tout le fichier dès l'ouverture d'une note :
sans le contrôle de disponibilité, chaque note ouverte rapatrierait son audio.

## 4 ter. macOS uniquement

L'app (desktop et CLI embarqué) ne vise plus que macOS (Apple Silicon et
Intel). Tout ce qui ne servait qu'à Windows ou Linux est retiré :

- **Code Rust** : branches `#[cfg(target_os = "windows" | "linux")]`,
  `cfg(windows)`, `cfg(not(unix))`, `cfg(not(target_os = "macos"))` et leurs
  dépendances `[target.…]`, dans `crates/`, `plugins/`, `apps/desktop/src-tauri`
  et `apps/cli`. Les branches `cfg(unix)` restent (macOS en fait partie).
  `apps/desktop/src-tauri/src/lib.rs` refuse de compiler hors macOS
  (`compile_error!`). `enterprise/` n'est pas concerné : ses workers tournent
  sur des serveurs Linux, donc les crates qu'il utilise (`cloudsync`,
  `db-core`, `db-app`, `db-migrate`, `agent-access`…) gardent leurs branches
  Linux ; seuls Windows et le mobile y sont retirés.
- **Front** : branches `platform() === "windows" | "linux"`, barre de titre
  Windows, libellés « Ctrl » / « Show in folder ».
- **Packaging** : Flatpak, AUR, APT, AppImage, `bundle.linux` / `bundle.windows`
  des `tauri.conf*.json`, workflow Microsoft Store.
- **CI** : jobs `windows_ci` / `linux_ci` de `desktop_ci.yaml`, `cli-windows` ;
  `cli-ci` tourne désormais sur un runner macOS. Les scripts `setup-linux*.sh`
  et la QA audio Linux sont supprimés.

Conséquence : le code Rust de l'app ne compile plus que sur un Mac. Un
`cargo check` sous Linux (conteneur cloud, CI Ubuntu) n'est plus un signal
valable ; seuls les checks JS et les crates indépendants de la plateforme
restent vérifiables ailleurs. Les chemins supprimés sont listés dans
`branding/removed-paths.txt` ; les suppressions *dans* des fichiers partagés
avec upstream, elles, produiront des conflits à chaque merge qui touche ces
lignes : les résoudre en gardant la version sans branche Windows/Linux.

## 5. Après une mise à jour upstream

```bash
git fetch upstream && git rebase upstream/main
```

Ordre de résolution conseillé :

1. **Section 1** — vérifier si upstream a relevé `swift-rs` et sa toolchain ;
   si oui, abandonner nos correctifs.
2. **Sections 2 à 4** — réappliquer ; les commentaires `[fork]` marquent les
   points d'insertion.
3. Reconstruire et **vérifier que la fenêtre s'ouvre** : une panique de
   `tauri-specta` tue l'application silencieusement, sans message visible
   ailleurs que sur stderr.

## Pièges rencontrés

- Le `target/debug` atteint **35 Go** après quelques cycles de diagnostic.
  Un `cargo clean` périodique évite de saturer le disque en pleine compilation.
- Les erreurs de démarrage n'apparaissent pas dans `~/Library/Logs/com.hyprnote.dev/app.log`
  (écriture asynchrone, perdue si le processus meurt). Il faut lire **stderr**.
- Une app dev n'est pas un bundle `.app` : les permissions macOS d'audio
  système, d'accessibilité et de calendrier ne peuvent pas être accordées,
  faute d'apparaître dans les Réglages Système.
