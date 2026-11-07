import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";

import { getBaseLanguageDisplayName, parseLocale } from "./language";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "./searchable-select";

import { SUPPORTED_DISPLAY_LOCALES } from "~/i18n/locales";
import { SettingRow } from "~/settings/setting-row";

const FOLLOW_MAIN_LANGUAGE = "__main__";

export function AppLanguageView({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { i18n, t } = useLingui();

  const options: SearchableSelectOption[] = useMemo(
    () => [
      { value: FOLLOW_MAIN_LANGUAGE, label: t`Same as main language` },
      ...SUPPORTED_DISPLAY_LOCALES.map((code) => ({
        value: code,
        label: getBaseLanguageDisplayName(code, i18n.locale),
      })).sort((a, b) => a.label.localeCompare(b.label, i18n.locale)),
    ],
    [i18n.locale, t],
  );

  return (
    <SettingRow
      title={<Trans>App language</Trans>}
      description={
        <Trans>
          Language of BlackMushi's menus and buttons. Transcription and AI
          answers keep the main language below.
        </Trans>
      }
    >
      {(labelProps) => (
        <SearchableSelect
          {...labelProps}
          value={value || FOLLOW_MAIN_LANGUAGE}
          onChange={(next) =>
            onChange(next === FOLLOW_MAIN_LANGUAGE ? "" : next)
          }
          options={options}
          placeholder={t`Select language`}
          searchPlaceholder={t`Search language...`}
          emptyMessage={t`No matching languages found`}
          className="w-full"
        />
      )}
    </SettingRow>
  );
}

export function MainLanguageView({
  value,
  onChange,
  supportedLanguages,
}: {
  value: string;
  onChange: (value: string) => void;
  supportedLanguages: readonly string[];
}) {
  const { i18n, t } = useLingui();

  const deduped = useMemo(() => {
    const map = new Map<string, string>();
    for (const code of supportedLanguages) {
      const { language } = parseLocale(code);
      if (!map.has(language)) {
        map.set(language, code);
      }
    }
    return map;
  }, [supportedLanguages]);

  const normalizedValue = useMemo(() => {
    const { language } = parseLocale(value);
    return deduped.get(language) ?? value;
  }, [value, deduped]);

  const options: SearchableSelectOption[] = useMemo(
    () =>
      [...deduped.values()].map((code) => ({
        value: code,
        label: getBaseLanguageDisplayName(code, i18n.locale),
      })),
    [deduped, i18n.locale],
  );

  return (
    <SettingRow
      title={<Trans>Main language</Trans>}
      description={
        <Trans>Default language for transcription and AI responses.</Trans>
      }
    >
      {(labelProps) => (
        <SearchableSelect
          {...labelProps}
          value={normalizedValue}
          onChange={onChange}
          options={options}
          placeholder={t`Select language`}
          searchPlaceholder={t`Search language...`}
          emptyMessage={t`No matching languages found`}
          className="w-full"
        />
      )}
    </SettingRow>
  );
}
