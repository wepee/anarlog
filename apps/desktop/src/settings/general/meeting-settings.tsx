import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { open as selectFolder } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";

import { Button } from "@anlg/ui/components/ui/button";
import { toast } from "@anlg/ui/components/ui/toast";

import { setSettingValue } from "~/settings/queries";
import { SettingRow, SettingSwitchRow } from "~/settings/setting-row";
import { useConfigValue } from "~/shared/config";

interface SettingItem {
  value: boolean;
  onChange: (value: boolean) => void;
}

export function MeetingSettingsView({
  autoJoinScheduledMeetings,
  autoStartScheduledMeetings,
  autoStopMeetings,
  autoRecordDetectedMeetings,
  floatingBar,
  meetingDisclosureAutoPost,
  captureMeetingChat,
  liveAssistEnabled,
  liveAssistWebResearch,
  liveAssistAutoAnswers,
  captureSharedScreens,
}: {
  autoJoinScheduledMeetings: SettingItem;
  autoStartScheduledMeetings: SettingItem;
  autoStopMeetings: SettingItem;
  autoRecordDetectedMeetings: SettingItem;
  floatingBar: SettingItem;
  meetingDisclosureAutoPost: SettingItem;
  captureMeetingChat: SettingItem;
  liveAssistEnabled: SettingItem;
  liveAssistWebResearch: SettingItem;
  liveAssistAutoAnswers: SettingItem;
  captureSharedScreens: SettingItem;
}) {
  const currentPlatform = platform();
  const supportsMeetingAx =
    currentPlatform === "macos" || currentPlatform === "linux";
  const supportsMicDetection = currentPlatform !== "windows";
  const supportsScreenCapture =
    currentPlatform === "macos" || currentPlatform === "windows";

  return (
    <div className="flex flex-col gap-4">
      <SettingSwitchRow
        title={<Trans>Start when meeting begins</Trans>}
        description={
          <Trans>Start listening when a scheduled meeting begins.</Trans>
        }
        checked={autoStartScheduledMeetings.value}
        onChange={autoStartScheduledMeetings.onChange}
      />
      <SettingSwitchRow
        title={<Trans>Join scheduled meetings</Trans>}
        description={
          <Trans>Open the meeting link when a scheduled meeting begins.</Trans>
        }
        checked={autoJoinScheduledMeetings.value}
        onChange={autoJoinScheduledMeetings.onChange}
        disabled={!autoStartScheduledMeetings.value}
      />
      {supportsMicDetection && (
        <SettingSwitchRow
          title={<Trans>Stop when meeting ends</Trans>}
          description={<Trans>Stop listening when your call ends.</Trans>}
          checked={autoStopMeetings.value}
          onChange={autoStopMeetings.onChange}
        />
      )}
      {supportsMeetingAx && (
        <>
          <SettingSwitchRow
            title={<Trans>Start when a meeting app is detected</Trans>}
            description={
              <Trans>
                Use Accessibility to detect Zoom, Google Meet, or Teams open
                with an active call, and start listening automatically, even
                without a scheduled meeting.
              </Trans>
            }
            checked={autoRecordDetectedMeetings.value}
            onChange={autoRecordDetectedMeetings.onChange}
          />
          <SettingSwitchRow
            title={<Trans>Post recording disclosure in meeting chat</Trans>}
            description={
              <Trans>
                Tell participants when listening starts; this does not confirm
                consent.
              </Trans>
            }
            checked={meetingDisclosureAutoPost.value}
            onChange={meetingDisclosureAutoPost.onChange}
          />
          <SettingSwitchRow
            title={<Trans>Capture meeting chat in Memos</Trans>}
            description={
              <Trans>
                Save visible chat from supported meetings using Accessibility.
              </Trans>
            }
            checked={captureMeetingChat.value}
            onChange={captureMeetingChat.onChange}
          />
        </>
      )}
      {supportsScreenCapture && (
        <SettingSwitchRow
          title={<Trans>Capture shared screens in Memos</Trans>}
          description={
            <Trans>
              Save slides and screens others share in meetings. Requires Screen
              Recording.
            </Trans>
          }
          checked={captureSharedScreens.value}
          onChange={captureSharedScreens.onChange}
        />
      )}
      <SettingSwitchRow
        title={<Trans>Show floating bar</Trans>}
        description={
          <Trans>Control listening without reopening BlackMushi.</Trans>
        }
        checked={floatingBar.value}
        onChange={floatingBar.onChange}
      />
      <SettingSwitchRow
        title={<Trans>Live Assist</Trans>}
        description={
          <Trans>
            While a meeting is transcribed live, the floating bar suggests the
            questions to ask, drafts the to-do and keeps a running summary.
            Sends the new transcript to your configured AI provider about once a
            minute.
          </Trans>
        }
        checked={liveAssistEnabled.value}
        onChange={liveAssistEnabled.onChange}
      />
      {liveAssistEnabled.value && (
        <SettingSwitchRow
          title={<Trans>Live Assist web research</Trans>}
          description={
            <Trans>
              Looks up companies, products or rules mentioned in the call to
              suggest better questions. Only the name is searched, through your
              AI provider's web search (Anthropic, OpenAI or Google).
            </Trans>
          }
          checked={liveAssistWebResearch.value}
          onChange={liveAssistWebResearch.onChange}
        />
      )}
      {liveAssistEnabled.value && (
        <SettingSwitchRow
          title={<Trans>Suggested answers</Trans>}
          description={
            <Trans>
              When someone asks you a question during the call, the floating bar
              suggests an answer from the call, your notes, your Obsidian vault
              and the web.
            </Trans>
          }
          checked={liveAssistAutoAnswers.value}
          onChange={liveAssistAutoAnswers.onChange}
        />
      )}
      {liveAssistEnabled.value && <ObsidianVaultRow />}
    </div>
  );
}

function ObsidianVaultRow() {
  const { t } = useLingui();
  const path = useConfigValue("obsidian_vault_path");
  const update = useMutation({
    mutationFn: async (clear: boolean) => {
      if (clear) {
        await setSettingValue("obsidian_vault_path", "");
        return;
      }
      const selected = await selectFolder({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await setSettingValue("obsidian_vault_path", selected);
      }
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <SettingRow
      title={<Trans>Obsidian vault</Trans>}
      description={
        path ? (
          <span className="break-all">{path}</span>
        ) : (
          <Trans>
            Pick your vault folder so suggested answers can use your Obsidian
            notes. They are read on your computer only.
          </Trans>
        )
      }
      controlWidth="content"
    >
      {() => (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate(false)}
          >
            {path ? t`Change` : t`Choose folder`}
          </Button>
          {path ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate(true)}
            >
              <Trans>Remove</Trans>
            </Button>
          ) : null}
        </div>
      )}
    </SettingRow>
  );
}
