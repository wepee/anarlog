-- L'import de réunions écrivait le décalage du premier mot dans started_at_ms
-- au lieu de l'heure de début. Les transcripts importés se retrouvaient datés
-- de 1970 dans les statistiques. On les recale sur created_at, qui porte la
-- date de la réunion ; les décalages des mots restent relatifs à ce début.
UPDATE transcripts
SET
  ended_at_ms = CASE
    WHEN ended_at_ms IS NULL THEN NULL
    ELSE CAST(round((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER) + ended_at_ms
  END,
  started_at_ms = CAST(round((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source = 'import'
  AND started_at_ms < 946684800000
  AND julianday(created_at) IS NOT NULL;
