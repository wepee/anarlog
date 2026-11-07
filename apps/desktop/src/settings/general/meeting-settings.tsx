import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { platform } from "@tauri-apps/plugin-os";

import { Button } from "@anlg/ui/components/ui/button";
import { toast } from "@anlg/ui/components/ui/toast";

import {
  copyLiveAssistJournal,
  saveLiveAssistJournal,
} from "~/session/live-assist/journal";
import { SettingRow, SettingSwitchRow } from "~/settings/setting-row";

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
      {liveAssistEnabled.value && <LiveAssistJournalRow />}
    </div>
  );
}

function LiveAssistJournalRow() {
  const { t } = useLingui();
  const copy = useMutation({
    mutationFn: copyLiveAssistJournal,
    onSuccess: () => toast.success(t`Live Assist log copied.`),
    onError: (error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: saveLiveAssistJournal,
    onSuccess: () => toast.success(t`Live Assist log saved to Downloads.`),
    onError: (error) => toast.error(error.message),
  });

  return (
    <SettingRow
      title={<Trans>Live Assist log</Trans>}
      description={
        <Trans>
          Everything Live Assist did since BlackMushi started: prompts, model
          answers and template choices. It includes excerpts of your calls and
          only leaves your computer if you share it.
        </Trans>
      }
      controlWidth="content"
    >
      {() => (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={copy.isPending}
            onClick={() => copy.mutate()}
          >
            <Trans>Copy</Trans>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            <Trans>Save</Trans>
          </Button>
        </div>
      )}
    </SettingRow>
  );
}
